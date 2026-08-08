/**
 * Fast unit coverage of the orchestration: git provenance wiring, payload keys, transport
 * and error reporting. The language services are faked here - `handler.integration.spec.ts`
 * covers the same handler against real language services and real workspaces on disk.
 */
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:process'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publishHandler } from './handler'
import type { PublishPayload } from './payload'

type MockModelData = {
  _stage: 'layouted'
  projectId: string
  elements: Record<string, unknown>
  deployments: { elements: Record<string, unknown> }
  views: Record<string, { nodes: unknown[] }>
}

type MockLikeC4 = {
  projectsManager: {
    all: string[]
    getProject: (id: string) => { folderUri: { fsPath: string } }
  }
  languageServices: {
    projects: () => Array<{ id: string; folder: { fsPath: string } }>
  }
  layoutedModel: (id: string) => Promise<{ $data: MockModelData }>
  [Symbol.asyncDispose]: () => Promise<void>
}

/** A layouted model whose single view renders `nodeCount` nodes. */
function modelWithNodes(id: string, nodeCount: number): MockModelData {
  return {
    _stage: 'layouted',
    projectId: id,
    // deliberately no elements of its own - a project can render purely from `import`
    elements: {},
    deployments: { elements: {} },
    // LikeC4 auto-generates an `index` view even for a completely empty project
    views: { index: { nodes: Array.from({ length: nodeCount }, (_, i) => ({ id: `n${i}` })) } },
  }
}

const fromWorkspace = vi.hoisted(() => vi.fn<() => Promise<MockLikeC4>>())
const createGitRunner = vi.hoisted(() => vi.fn<() => (args: readonly string[]) => Promise<string>>())
const logs = vi.hoisted(() => ({ info: [] as string[], warn: [] as string[], error: [] as string[] }))

vi.mock('@likec4/language-services/node', () => ({
  fromWorkspace,
}))

// `readGitProvenance`, `parseGitOrigin` etc. stay real - only spawning `git` is faked
vi.mock('./git', async importOriginal => {
  const actual = await importOriginal<typeof import('./git')>()
  return {
    ...actual,
    createGitRunner,
  }
})

vi.mock('../../logger', async importOriginal => {
  const actual = await importOriginal<typeof import('../../logger')>()
  return {
    ...actual,
    createLikeC4Logger: () => ({
      info: (msg: string) => void logs.info.push(msg),
      debug: () => {},
      warn: (msg: unknown) => void logs.warn.push(String(msg)),
      warnOnce: (msg: string) => void logs.warn.push(msg),
      error: (msg: unknown) => void logs.error.push(String(msg)),
      clearScreen: () => {},
      hasErrorLogged: () => false,
      hasWarned: false,
    }),
  }
})

/** A runner that behaves as if `git` is not installed, or this is not a repository. */
function noGitRunner() {
  return (args: readonly string[]): Promise<string> => Promise.reject(new Error(`spawn git ${args.join(' ')} ENOENT`))
}

/** A runner answering from a fixed table keyed by the joined arguments; anything else fails. */
function fakeGitRunner(answers: Record<string, string>) {
  return (args: readonly string[]): Promise<string> => {
    const key = args.join(' ')
    const answer = answers[key]
    return answer === undefined ? Promise.reject(new Error(`git ${key} failed`)) : Promise.resolve(answer)
  }
}

const COMMIT_OUTPUT = ['Jane Doe', 'jane@acme.io', '2026-07-31T10:00:00+02:00', 'fix: something'].join('\0')

describe('publish handler', () => {
  const fetchMock = vi.fn<(request: Request, options?: unknown) => Promise<Response>>()
  let tmp: string
  let workspace: string
  let previousExitCode: typeof process.exitCode
  /** Request bodies captured at call time - the Request body is not readable afterwards */
  let sentBodies: Uint8Array[]
  let respondWith: () => Response

  beforeEach(async () => {
    previousExitCode = process.exitCode
    tmp = await mkdtemp(join(tmpdir(), 'likec4-publish-'))
    workspace = join(tmp, 'workspace')
    logs.info.length = 0
    logs.warn.length = 0
    logs.error.length = 0
    sentBodies = []
    respondWith = () => Response.json({ success: true, snapshotId: 'snapshot-1' })
    fetchMock.mockImplementation(async request => {
      sentBodies.push(new Uint8Array(await request.clone().arrayBuffer()))
      return respondWith()
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    process.exitCode = previousExitCode
    await rm(tmp, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  /**
   * Registers the given projects (id -> folder), each rendering one node unless `modelFor`
   * says otherwise.
   *
   * Mirrors the real `ProjectsManager`: `all` additionally carries the synthetic `default`
   * entry pointing at the workspace root, while `languageServices.projects()` lists only
   * the projects that own source documents.
   */
  function mockWorkspace(
    projects: Record<string, string>,
    options: { modelFor?: (id: string) => MockModelData; defaultOwnsDocuments?: boolean } = {},
  ) {
    const documentOwners = Object.keys(projects)
    const folders = new Map(Object.entries(projects))
    if (!folders.has('default')) {
      folders.set('default', workspace)
      if (options.defaultOwnsDocuments === true) {
        documentOwners.push('default')
      }
    }
    fromWorkspace.mockResolvedValue({
      projectsManager: {
        all: [...folders.keys()],
        getProject: (id: string) => ({ folderUri: { fsPath: folders.get(id)! } }),
      },
      languageServices: {
        projects: () => documentOwners.map(id => ({ id, folder: { fsPath: folders.get(id)! } })),
      },
      layoutedModel: (id: string) => Promise.resolve({ $data: options.modelFor?.(id) ?? modelWithNodes(id, 1) }),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    })
  }

  /** The single request handed to fetch. */
  function sentRequest(): Request {
    expect(fetchMock).toHaveBeenCalledOnce()
    return fetchMock.mock.calls[0]![0]
  }

  /** Ungzips the single captured request body. */
  function sentPayload(): PublishPayload {
    expect(sentBodies).toHaveLength(1)
    return JSON.parse(gunzipSync(sentBodies[0]!).toString('utf8')) as PublishPayload
  }

  const baseArgs = {
    token: 'test-token',
    url: 'http://localhost:5173',
    project: undefined,
    branch: 'main',
    tag: undefined,
    force: false,
    useDotBin: false,
  }

  describe('without a git repository (--origin + --sha escape hatch)', () => {
    beforeEach(() => {
      createGitRunner.mockReturnValue(noGitRunner())
    })

    const escapeHatchArgs = {
      ...baseArgs,
      origin: 'acme/architecture',
      sha: 'deadbeef',
    }

    it('publishes a project at the workspace root as "."', async () => {
      mockWorkspace({ default: workspace })

      await publishHandler({ ...escapeHatchArgs, path: workspace })

      const payload = sentPayload()
      expect(Object.keys(payload.projects)).toEqual(['.'])
      expect(payload.origin).toBe('acme/architecture')
      expect(payload.sha).toBe('deadbeef')
      expect(payload.branch).toBe('main')
    })

    it('resolves nested project folders against the workspace path, not process.cwd()', async () => {
      mockWorkspace({
        alpha: join(workspace, 'alpha'),
        beta: join(workspace, 'nested', 'beta'),
      })

      await publishHandler({ ...escapeHatchArgs, path: workspace })

      expect(Object.keys(sentPayload().projects).sort()).toEqual(['alpha', 'nested/beta'])
    })

    it('sends an empty commit rather than failing', async () => {
      mockWorkspace({ default: workspace })

      await publishHandler({ ...escapeHatchArgs, path: workspace })

      expect(sentPayload().commit).toMatchObject({ message: '', author: '', email: '' })
    })

    it('does not repeat the undetermined-working-tree warning on top of the no-git one', async () => {
      mockWorkspace({ default: workspace })

      await publishHandler({ ...escapeHatchArgs, path: workspace })

      expect(logs.warn).toContainEqual(expect.stringContaining('No git repository detected'))
      expect(logs.warn.join('\n')).not.toMatch(/Could not determine whether the working tree/)
    })

    it('fails without sending a request when only --origin is given', async () => {
      mockWorkspace({ default: workspace })

      await expect(publishHandler({ ...escapeHatchArgs, sha: undefined, path: workspace }))
        .rejects.toThrow(/--origin and --sha/)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('inside a git repository', () => {
    beforeEach(() => {
      createGitRunner.mockReturnValue(fakeGitRunner({
        'rev-parse --show-toplevel': tmp,
        'remote get-url origin': 'git@github.com:acme/architecture.git',
        'rev-parse HEAD': 'abc123',
        'log -1 --format=%an%x00%ae%x00%aI%x00%s': COMMIT_OUTPUT,
        'symbolic-ref --short -q HEAD': 'feature/x',
        'status --porcelain': '',
      }))
    })

    it('keys projects by their path from the git root', async () => {
      mockWorkspace({ alpha: join(workspace, 'alpha') })

      await publishHandler({ ...baseArgs, branch: undefined, path: workspace, origin: undefined, sha: undefined })

      const payload = sentPayload()
      expect(Object.keys(payload.projects)).toEqual(['workspace/alpha'])
      expect(payload.origin).toBe('acme/architecture')
      expect(payload.sha).toBe('abc123')
      expect(payload.commit).toEqual({
        message: 'fix: something',
        author: 'Jane Doe',
        email: 'jane@acme.io',
        date: '2026-07-31T08:00:00.000Z',
      })
    })

    it('drops the synthetic default project when it owns nothing', async () => {
      mockWorkspace({ alpha: join(workspace, 'alpha'), beta: join(workspace, 'beta') })

      await publishHandler({ ...baseArgs, path: workspace, origin: undefined, sha: undefined })

      expect(Object.keys(sentPayload().projects).sort()).toEqual(['workspace/alpha', 'workspace/beta'])
    })

    it('keeps the default project when it owns stray sources outside every other project', async () => {
      mockWorkspace(
        { alpha: join(workspace, 'alpha') },
        { defaultOwnsDocuments: true },
      )

      await publishHandler({ ...baseArgs, path: workspace, origin: undefined, sha: undefined })

      expect(Object.keys(sentPayload().projects).sort()).toEqual(['workspace', 'workspace/alpha'])
    })

    it('does not warn about the working tree when git reports it clean', async () => {
      mockWorkspace({ default: workspace })

      await publishHandler({ ...baseArgs, path: workspace, origin: undefined, sha: undefined })

      expect(logs.warn.join('\n')).not.toMatch(/working tree/i)
    })

    it('warns that the working tree state is undetermined when git status cannot be read', async () => {
      // same repository, but `git status --porcelain` is not answered
      createGitRunner.mockReturnValue(fakeGitRunner({
        'rev-parse --show-toplevel': tmp,
        'remote get-url origin': 'git@github.com:acme/architecture.git',
        'rev-parse HEAD': 'abc123',
        'log -1 --format=%an%x00%ae%x00%aI%x00%s': COMMIT_OUTPUT,
        'symbolic-ref --short -q HEAD': 'feature/x',
      }))
      mockWorkspace({ default: workspace })

      await publishHandler({ ...baseArgs, path: workspace, origin: undefined, sha: undefined })

      expect(logs.warn).toContainEqual(
        expect.stringContaining('Could not determine whether the working tree is clean'),
      )
    })

    it('posts a gzipped body with the publish token header', async () => {
      mockWorkspace({ default: workspace })

      await publishHandler({ ...baseArgs, path: workspace, origin: undefined, sha: undefined })

      const request = sentRequest()
      expect(request.url).toBe('http://localhost:5173/api/publish')
      expect(request.method).toBe('POST')
      expect(request.headers.get('X-Publish-Token')).toBe('test-token')
      expect(request.headers.get('Content-Type')).toBe('application/json')
      expect(request.headers.get('Content-Encoding')).toBe('gzip')
      // gzip magic bytes
      const body = sentBodies[0]!
      expect([body[0], body[1]]).toEqual([0x1f, 0x8b])
    })

    it('publishes a project that owns no elements but still renders nodes', async () => {
      // e.g. a project composed entirely from `import { … } from 'base'`
      mockWorkspace({ importer: join(workspace, 'importer') }, { modelFor: id => modelWithNodes(id, 2) })

      await publishHandler({ ...baseArgs, path: workspace, origin: undefined, sha: undefined })

      expect(Object.keys(sentPayload().projects)).toEqual(['workspace/importer'])
      expect(logs.warn.join('\n')).not.toMatch(/is empty, skipping/)
    })

    it('skips empty projects and refuses to publish when none are left', async () => {
      mockWorkspace({ blank: workspace }, { modelFor: id => modelWithNodes(id, 0) })

      await expect(publishHandler({ ...baseArgs, path: workspace, origin: undefined, sha: undefined }))
        .rejects.toThrow(/Nothing to publish/)
      expect(logs.warn).toContainEqual(expect.stringContaining('Project blank is empty, skipping'))
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('prints the server error body verbatim and exits with code 1', async () => {
      mockWorkspace({ default: workspace })
      const serverBody = 'Invalid request body\n✖ Invalid input: expected "acme/architecture"\n  → at origin'
      respondWith = () => new Response(serverBody, { status: 400, statusText: 'Bad Request' })

      await publishHandler({ ...baseArgs, path: workspace, origin: undefined, sha: undefined })

      expect(process.exitCode).toBe(1)
      expect(logs.error).toContain(serverBody)
      expect(logs.error.join('\n')).toContain('400')
    })

    // symlinks need elevated privileges on Windows
    it.skipIf(platform === 'win32')('publishes through a symlinked checkout', async () => {
      // `git rev-parse --show-toplevel` reports the physical path, the user passes the link
      const physical = join(tmp, 'physical')
      const link = join(tmp, 'link')
      await mkdir(join(physical, 'alpha'), { recursive: true })
      await symlink(physical, link, 'dir')
      createGitRunner.mockReturnValue(fakeGitRunner({
        'rev-parse --show-toplevel': physical,
        'remote get-url origin': 'git@github.com:acme/architecture.git',
        'rev-parse HEAD': 'abc123',
        'log -1 --format=%an%x00%ae%x00%aI%x00%s': COMMIT_OUTPUT,
        'status --porcelain': '',
      }))
      mockWorkspace({ alpha: join(link, 'alpha') })

      await publishHandler({ ...baseArgs, path: link, origin: undefined, sha: undefined })

      expect(Object.keys(sentPayload().projects)).toEqual(['alpha'])
    })

    it('does not retry a 401, and never puts the token into a log line', async () => {
      mockWorkspace({ default: workspace })
      respondWith = () => new Response('Invalid publish token', { status: 401 })

      await publishHandler({ ...baseArgs, path: workspace, origin: undefined, sha: undefined })

      expect(fetchMock).toHaveBeenCalledOnce()
      expect([...logs.info, ...logs.warn, ...logs.error].join('\n')).not.toContain('test-token')
    })
  })
})

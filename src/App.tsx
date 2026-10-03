import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Code2,
  Command,
  Copy,
  FileCode2,
  GitBranch,
  GitCompareArrows,
  Globe2,
  LayoutGrid,
  Link2,
  Loader2,
  LogOut,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  Plus,
  PanelRightClose,
  PanelRightOpen,
  Radio,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Users,
  Vote,
  Waves,
  X,
  Zap,
} from 'lucide-react';
import type { Agent, Decision, HostConfig, Room, Session } from '../shared/types';
import type { HarnessModel } from '../shared/models';
import { VOTE_DURATION_MS } from '../shared/types';
import type { Harness, RunnerProject } from '../shared/runner';
import { api, ApiError } from './api';
import { createMembershipStore, normalizeRoomCode, type SavedMembership } from './membership';
import { LandingPreview } from './LandingPreview';

const memberships = createMembershipStore(
  {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: (key) => localStorage.removeItem(key),
  },
  {
    getItem: (key) => sessionStorage.getItem(key),
    setItem: (key, value) => sessionStorage.setItem(key, value),
    removeItem: (key) => sessionStorage.removeItem(key),
  },
);
const colors = ['lime', 'lavender', 'peach', 'blue'];
const formatTime = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const activeDecision = (d: Decision) => ['open', 'owner-needed'].includes(d.status);
function Logo({ small = false }: { small?: boolean }) {
  return (
    <div className={`brand ${small ? 'brand-small' : ''}`}>
      <span className="brand-mark">
        <span />
        <span />
        <span />
      </span>
      <span>
        multiplayer<span className="brand-period">.</span>
      </span>
    </div>
  );
}
function Avatar({
  name,
  color = 0,
  small = false,
}: {
  name: string;
  color?: number;
  small?: boolean;
}) {
  return (
    <span className={`avatar ${colors[color % 4]} ${small ? 'small' : ''}`} title={name}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
function Button({
  children,
  onClick,
  kind = 'secondary',
  disabled,
  type = 'button',
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'secondary' | 'ghost';
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
}) {
  return (
    <button
      className={`button ${kind} ${className}`}
      type={type}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function Modal({
  title,
  eyebrow,
  children,
  close,
  wide = false,
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = ref.current!;
    const focusable = () => [
      ...panel.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input, textarea, select, a[href], [tabindex="0"]',
      ),
    ];
    (focusable().find((el) => el.tagName === 'INPUT') || focusable()[0])?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const nodes = focusable();
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', key);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={ref}
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2>{title}</h2>
          </div>
          <button className="icon-button" onClick={close} aria-label="Close dialog">
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(() => memberships.active());
  const [room, setRoom] = useState<Room | null>(null);
  const [config, setConfig] = useState<HostConfig | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected'>(
    'connecting',
  );
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    void api<HostConfig>('/api/config', null)
      .then(setConfig)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!session) return;
    let closed = false;
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let retry = 0;
    const connect = async () => {
      setConnection('connecting');
      try {
        const state = await api<Room>('/api/room', session);
        if (closed) return;
        memberships.remember(session, state);
        setRoom(state);
      } catch (e) {
        if (closed) return;
        const message = (e as Error).message;
        setError(message);
        setConnection('disconnected');
        if (e instanceof ApiError && [401, 404].includes(e.status)) {
          memberships.forget(session.token);
          setSession(null);
          setRoom(null);
          return;
        }
        timer = setTimeout(connect, 3000);
        return;
      }
      socket = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?token=${encodeURIComponent(session.token)}`,
      );
      socket.onopen = () => {
        if (closed) return;
        retry = 0;
        setConnection('connected');
      };
      socket.onmessage = (event) => {
        if (closed) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'state') setRoom(message.room);
        } catch {
          /* A malformed event must not break reconnection. */
        }
      };
      socket.onclose = () => {
        if (closed) return;
        setConnection('disconnected');
        timer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000));
      };
      socket.onerror = () => socket?.close();
    };
    void connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [session]);
  function enter(result: { session: Session; room: Room }) {
    const remembered = memberships.enter(result.session, result.room);
    setSession(result.session);
    setRoom(result.room);
    setError(
      remembered
        ? ''
        : 'Browser storage is unavailable. Keep this tab open to retain access to your agents.',
    );
    history.replaceState({}, '', location.pathname);
  }
  function leave() {
    if (session && room && !memberships.remember(session, room)) {
      setError(
        'Your browser could not remember this profile. Enable site storage before leaving so you can return to your agents.',
      );
      return;
    }
    memberships.leave();
    setSession(null);
    setRoom(null);
    setError('');
  }
  async function action(url: string, data: unknown = {}) {
    if (connection !== 'connected') {
      setError('Reconnecting to the host. Try again once connected.');
      return false;
    }
    try {
      await api(url, session, data);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }
  return (
    <>
      {session && room ? (
        <Workspace
          room={room}
          session={session}
          config={config}
          connection={connection}
          now={now}
          action={action}
          leave={leave}
          notify={setToast}
          onError={setError}
        />
      ) : session ? (
        <div className="loading-screen">
          <Logo />
          <Loader2 className="spin" />
          Rejoining your room…<Button onClick={leave}>Back to lobby</Button>
        </div>
      ) : (
        <Lobby config={config} onConfig={setConfig} enter={enter} onError={setError} />
      )}
      {error && (
        <div className="toast error-toast" role="alert">
          <CircleHelp size={19} />
          <span>{error}</span>
          <button className="icon-button" onClick={() => setError('')} aria-label="Dismiss error">
            <X size={16} />
          </button>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          <span>{toast}</span>
        </div>
      )}
    </>
  );
}

function Lobby({
  config,
  onConfig,
  enter,
  onError,
}: {
  config: HostConfig | null;
  onConfig: (config: HostConfig) => void;
  enter: (r: { room: Room; session: Session }) => void;
  onError: (s: string) => void;
}) {
  const inviteCode = new URLSearchParams(location.search).get('join') || '';
  const [saved, setSaved] = useState(() => memberships.list());
  const [tab, setTab] = useState<'host' | 'join'>(inviteCode ? 'join' : 'host');
  const [name, setName] = useState('');
  const [roomName, setRoomName] = useState('The build room');
  const [code, setCode] = useState(inviteCode);
  const [busy, setBusy] = useState('');
  const [newProfile, setNewProfile] = useState(false);
  const [projectId, setProjectId] = useState('default');
  const [projectPath, setProjectPath] = useState('');
  const [addingProject, setAddingProject] = useState(false);
  const selectedProject = config?.projects?.find((project) => project.id === projectId);
  const returning =
    !newProfile &&
    saved.find((item) => normalizeRoomCode(item.roomCode) === normalizeRoomCode(code));
  useEffect(() => {
    const update = () => setSaved(memberships.list());
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, []);
  async function resume(saved: SavedMembership) {
    setBusy(`resume:${saved.session.memberId}`);
    try {
      enter(await memberships.resume(saved, (session) => api<Room>('/api/room', session)));
    } catch (e) {
      setSaved(memberships.list());
      onError(
        e instanceof ApiError && [401, 404].includes(e.status)
          ? 'This saved room profile has expired. The server may have restarted; ask your teammate for the current room code.'
          : (e as Error).message,
      );
    } finally {
      setBusy('');
    }
  }
  async function create(mode: 'demo' | 'live') {
    setBusy(mode);
    try {
      enter(
        await api('/api/rooms', null, {
          name: mode === 'demo' ? 'The weekend build' : roomName,
          memberName: name.trim() || 'You',
          mode,
          ...(mode === 'live' ? { projectId } : {}),
        }),
      );
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function addProject() {
    setBusy('project');
    try {
      const result = await api<{ id: string }>('/api/projects', null, { path: projectPath });
      onConfig(await api<HostConfig>('/api/config', null));
      setProjectId(result.id);
      setProjectPath('');
      setAddingProject(false);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function join(e: FormEvent) {
    e.preventDefault();
    const previous =
      !newProfile &&
      memberships
        .list()
        .find((item) => normalizeRoomCode(item.roomCode) === normalizeRoomCode(code));
    if (previous) {
      await resume(previous);
      return;
    }
    setBusy('join');
    try {
      enter(await api('/api/join', null, { code, memberName: name.trim() || 'You' }));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="lobby">
      <header className="lobby-nav">
        <Logo />
        <span className="pill">
          <span className="dot" /> Made for building together
        </span>
        <a
          href="https://github.com/EyedBread/multiplayer-agentic-coding"
          target="_blank"
          rel="noreferrer"
        >
          View project <ArrowUpRight size={16} />
        </a>
      </header>
      <main className="lobby-main">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="tiny-cross">✳</span> MORE MINDS. ONE WORKSPACE.
          </div>
          <h1>
            Build in
            <br />
            <span>good company.</span>
          </h1>
          <p>
            Your team. Your agents. All in one room.
            <br />
            See the work unfold, make the calls together,
            <br className="desktop-break" /> and keep moving in the same direction.
          </p>
          <div className="hero-tags">
            <span>
              <Radio size={15} /> Live sessions
            </span>
            <span>
              <Vote size={16} /> Team decisions
            </span>
            <span>
              <GitCompareArrows size={16} /> Shared awareness
            </span>
          </div>
          <LandingPreview />
        </div>
        <div className="lobby-form-wrap">
          <div className="lobby-form">
            <span className="eyebrow">PULL UP A CHAIR</span>
            <h2>
              Great things start
              <br />
              with a room.
            </h2>
            {saved.length > 0 && (
              <section className="saved-rooms" aria-label="Remembered room profiles">
                <span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span>
                <div className="saved-room-list">
                  {saved.map((item) => (
                    <button
                      key={`${item.session.roomId}:${item.session.memberId}`}
                      type="button"
                      disabled={!!busy}
                      onClick={() => void resume(item)}
                      aria-label={`Rejoin ${item.roomName} as ${item.memberName}`}
                    >
                      <span className="saved-room-icon">
                        <Users size={16} />
                      </span>
                      <span>
                        <strong>{item.roomName}</strong>
                        <small>
                          Return as {item.memberName} · {item.roomCode}
                        </small>
                      </span>
                      {busy === `resume:${item.session.memberId}` ? (
                        <Loader2 size={16} className="spin" />
                      ) : (
                        <ArrowRight size={16} />
                      )}
                    </button>
                  ))}
                </div>
                <p>Your profile and agent ownership stay with you when you leave.</p>
              </section>
            )}
            <div className="segmented">
              <button className={tab === 'host' ? 'selected' : ''} onClick={() => setTab('host')}>
                Create a room
              </button>
              <button className={tab === 'join' ? 'selected' : ''} onClick={() => setTab('join')}>
                Join your team
              </button>
            </div>
            <form
              onSubmit={
                tab === 'join'
                  ? join
                  : (e) => {
                      e.preventDefault();
                      void create('live');
                    }
              }
            >
              <label>
                Your name
                <input
                  autoComplete="given-name"
                  maxLength={32}
                  placeholder="What should we call you?"
                  value={tab === 'join' && returning ? returning.memberName : name}
                  disabled={tab === 'join' && !!returning}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              {tab === 'host' ? (
                <>
                  <label>
                    Room name
                    <input
                      maxLength={60}
                      value={roomName}
                      onChange={(e) => setRoomName(e.target.value)}
                      required
                    />
                  </label>
                  {config?.projects ? (
                    <>
                      <label>
                        Project
                        <select
                          value={projectId}
                          onChange={(event) => setProjectId(event.target.value)}
                          disabled={!!busy}
                        >
                          {config.projects.map((project) => (
                            <option key={project.id} value={project.id}>
                              {project.name} · {project.branch || 'Unavailable'}
                              {project.path ? ` — ${project.path}` : ''}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="project-actions">
                        {config.canManageProjects && (
                          <Button
                            onClick={() => setAddingProject(!addingProject)}
                            disabled={!!busy}
                          >
                            <Plus size={14} />
                            {addingProject ? 'Cancel' : 'Add project'}
                          </Button>
                        )}
                        <Button
                          disabled={!!busy}
                          onClick={() => {
                            setBusy('projects');
                            void api<HostConfig>('/api/config', null)
                              .then(onConfig)
                              .catch((error: Error) => onError(error.message))
                              .finally(() => setBusy(''));
                          }}
                        >
                          Refresh projects
                        </Button>
                      </div>
                      {addingProject && (
                        <div className="project-add">
                          <label>
                            Repository folder on this computer
                            <input
                              value={projectPath}
                              onChange={(event) => setProjectPath(event.target.value)}
                              placeholder="/Users/you/projects/my-project"
                              disabled={!!busy}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault();
                                  if (!busy && projectPath.trim()) void addProject();
                                }
                              }}
                            />
                          </label>
                          <p className="form-note">
                            Choose an existing Git checkout. Teammates will be able to select it for
                            new rooms.
                          </p>
                          <Button
                            onClick={() => void addProject()}
                            disabled={!!busy || !projectPath.trim()}
                          >
                            {busy === 'project' && <Loader2 className="spin" size={14} />}Add
                            repository
                          </Button>
                        </div>
                      )}
                      {!config.canManageProjects && (
                        <p className="form-note">
                          The host can add more repositories from localhost.
                        </p>
                      )}
                      {selectedProject?.error && (
                        <p className="form-note">{selectedProject.error}</p>
                      )}
                    </>
                  ) : (
                    <div className="repo-target">
                      <div>
                        <GitBranch size={16} />
                        <strong>{config?.repoName || 'Finding your project…'}</strong>
                      </div>
                      <span>{config?.branch || 'Local Git project'}</span>
                    </div>
                  )}
                  {(selectedProject?.dirty ?? config?.dirty) && (
                    <p className="form-note">
                      Commit or stash this project’s changes before starting a live room.
                    </p>
                  )}
                  <Button
                    type="submit"
                    kind="primary"
                    disabled={
                      !!busy || !config?.canHost || !!selectedProject?.error || addingProject
                    }
                    className="full"
                  >
                    {busy === 'live' ? <Loader2 className="spin" size={17} /> : <Plus size={17} />}
                    Create live room
                    <ArrowRight size={17} />
                  </Button>
                  {config && !config.canHost && (
                    <p className="form-note">Room creation is currently unavailable.</p>
                  )}
                  {config && !config.codexAvailable && (
                    <p className="form-note">
                      Connect your own Codex or Claude runner after creating the room. Codex on the
                      server is currently unavailable.
                    </p>
                  )}
                  <div className="or-divider">
                    <span />
                    OR TAKE A LOOK AROUND
                    <span />
                  </div>
                  <Button className="full" onClick={() => void create('demo')} disabled={!!busy}>
                    {busy === 'demo' ? (
                      <Loader2 className="spin" size={17} />
                    ) : (
                      <Sparkles size={17} />
                    )}
                    Explore a demo room
                    <ArrowUpRight size={16} />
                  </Button>
                  <p className="form-note centered">
                    Simulated agents. Real multiplayer. No setup.
                  </p>
                </>
              ) : (
                <>
                  <label>
                    Room code
                    <input
                      className="code-input"
                      maxLength={20}
                      placeholder="Paste your room code"
                      value={code}
                      onChange={(e) => {
                        setCode(e.target.value);
                        setNewProfile(false);
                      }}
                      required
                    />
                  </label>
                  <p className="form-note">
                    {returning
                      ? `Welcome back, ${returning.memberName}. Rejoin your existing profile to keep access to your agents.`
                      : 'Use the link or code shared by your host. This browser will remember your room profile.'}
                  </p>
                  <Button type="submit" kind="primary" className="full" disabled={!!busy}>
                    {busy ? <Loader2 className="spin" size={17} /> : <Users size={17} />}
                    {returning ? `Rejoin as ${returning.memberName}` : 'Join the room'}
                    <ArrowRight size={17} />
                  </Button>
                  {returning && (
                    <button
                      className="different-profile"
                      type="button"
                      disabled={!!busy}
                      onClick={() => {
                        setNewProfile(true);
                        setName('');
                      }}
                    >
                      Different person? Join with a new profile
                    </button>
                  )}
                </>
              )}
            </form>
          </div>
          <p className="lobby-footnote">
            <ShieldCheck size={14} /> Run on the host or connect your own local harness.
          </p>
        </div>
      </main>
      <footer className="lobby-footer">
        <span>A little less silo. A lot more together.</span>
        <span>
          BUILT FOR THE WEEKEND. READY FOR THE TEAM. <span>↗</span>
        </span>
      </footer>
    </div>
  );
}

function ModelPicker({
  session,
  runnerId,
  value,
  onChange,
  disabled,
}: {
  session: Session;
  runnerId: string;
  value: string;
  onChange: (model: string) => void;
  disabled: boolean;
}) {
  const [models, setModels] = useState<HarnessModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [custom, setCustom] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (disabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    void api<{ models: HarnessModel[] }>('/api/models', session, {
      runnerId: runnerId || undefined,
    })
      .then((result) => {
        if (!cancelled) setModels(result.models);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session.token, runnerId, disabled]);
  return (
    <>
      <label>
        Model
        <select
          value={custom ? '__custom' : value}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            setCustom(next === '__custom');
            onChange(next === '__custom' ? '' : next);
          }}
        >
          <option value="">Harness default</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name} · {model.id}
            </option>
          ))}
          <option value="__custom">Custom model ID…</option>
        </select>
        <span className="field-help">
          {loading
            ? 'Loading models from this harness…'
            : failed
              ? 'Couldn’t load models. Use the harness default or enter a model ID.'
              : 'Choose a model for this agent. Availability depends on its harness account.'}
        </span>
      </label>
      {custom && (
        <label>
          Model ID
          <input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            required
            maxLength={160}
            placeholder="Model ID supported by this harness"
            disabled={disabled}
          />
        </label>
      )}
    </>
  );
}

type Action = (url: string, data?: unknown) => Promise<boolean>;
function Workspace({
  room,
  session,
  config,
  connection,
  now,
  action,
  leave,
  notify,
  onError,
}: {
  room: Room;
  session: Session;
  config: HostConfig | null;
  connection: string;
  now: number;
  action: Action;
  leave: () => void;
  notify: (s: string) => void;
  onError: (s: string) => void;
}) {
  const [view, setView] = useState<'workspace' | 'changes' | 'decisions'>('workspace');
  const [rail, setRail] = useState<'decisions' | 'activity'>('decisions');
  const [railCollapsed, setRailCollapsed] = useState(() => {
    try {
      return localStorage.getItem('multiplayer-sidebar-collapsed') === 'true';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('multiplayer-sidebar-collapsed', String(railCollapsed));
    } catch {
      /* The control still works when browser storage is unavailable. */
    }
  }, [railCollapsed]);
  function showDecisions() {
    setRail('decisions');
    setRailCollapsed(false);
    requestAnimationFrame(() =>
      document
        .querySelector('.right-rail')
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
    );
  }
  const [modal, setModal] = useState<'invite' | 'agent' | 'decision' | 'runner' | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [closingAgentId, setClosingAgentId] = useState<string | null>(null);
  const closingAgent = room.agents.find((agent) => agent.id === closingAgentId);
  useEffect(() => {
    if (focus && !room.agents.some((agent) => agent.id === focus)) setFocus(null);
  }, [focus, room.agents]);
  const [diff, setDiff] = useState<{
    file: string;
    agents: { name: string; content: string }[];
  } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [name, setName] = useState('');
  const [task, setTask] = useState('');
  const [selectedRunner, setSelectedRunner] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [question, setQuestion] = useState('');
  const [choices, setChoices] = useState(['', '']);
  const [busy, setBusy] = useState(false);
  const me = room.members.find((m) => m.id === session.memberId)!;
  const pending = room.decisions.filter(activeDecision);
  const settled = room.decisions.filter((d) => d.scope === 'team' && d.status === 'resolved');
  const decisionHistory = room.decisions.filter(
    (d) => d.scope === 'team' && ['resolved', 'cancelled'].includes(d.status),
  );
  const changedCount = new Set(room.agents.flatMap((a) => a.files)).size;
  const workingCount = room.agents.filter((a) => a.status === 'working').length;
  const agents = focus ? room.agents.filter((a) => a.id === focus) : room.agents;
  const enabled = connection === 'connected';
  const myRunners = (room.runners ?? []).filter((runner) => runner.ownerId === session.memberId);
  const chosenRunner = myRunners.find((runner) => runner.id === selectedRunner);
  const executionAvailable =
    room.mode === 'demo' ||
    (selectedRunner ? chosenRunner?.status === 'online' : config?.codexAvailable !== false);
  function openAgent() {
    setSelectedModel('');
    setSelectedRunner(myRunners.find((runner) => runner.status === 'online')?.id ?? '');
    setModal('agent');
  }
  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(`${location.origin}/?join=${room.code}`);
      notify('Invite link copied');
    } catch {
      onError('Clipboard unavailable. Copy the link from the invite dialog.');
      setModal('invite');
    }
  }
  async function showDiff(file: string, ids: string[]) {
    setDiffLoading(true);
    setDiff({ file, agents: [] });
    try {
      const agents = await Promise.all(
        ids.map(async (id) => ({
          name: room.agents.find((a) => a.id === id)!.name,
          content: (
            await api<{ diff: string }>(
              `/api/agents/${id}/diff?file=${encodeURIComponent(file)}`,
              session,
            )
          ).diff,
        })),
      );
      setDiff({ file, agents });
    } catch (e) {
      onError((e as Error).message);
      setDiff(null);
    } finally {
      setDiffLoading(false);
    }
  }
  async function submitAgent(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    if (
      await action('/api/agents', {
        name,
        task,
        ...(selectedRunner ? { runnerId: selectedRunner } : {}),
        ...(room.mode === 'live' && selectedModel ? { model: selectedModel } : {}),
      })
    ) {
      setModal(null);
      setName('');
      setTask('');
    }
    setBusy(false);
  }
  async function closeAgent() {
    if (!closingAgent || busy) return;
    setBusy(true);
    if (await action(`/api/agents/${closingAgent.id}/close`)) {
      setClosingAgentId(null);
      notify('Session closed. Worktree files preserved.');
    }
    setBusy(false);
  }
  async function submitDecision(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    if (await action('/api/decisions', { question, options: choices.filter((c) => c.trim()) })) {
      setModal(null);
      setQuestion('');
      setChoices(['', '']);
      showDecisions();
    }
    setBusy(false);
  }
  return (
    <div className="workspace-shell">
      <header className="topbar">
        <Logo small />
        <div className="topbar-divider" />
        <span className="repo-crumb">
          <GitBranch size={15} />
          {room.repoName}
          <ChevronDown size={13} />
        </span>
        <span className={`mode-badge ${room.mode}`}>
          {room.mode === 'demo' ? 'DEMO ROOM' : 'LIVE ROOM'}
        </span>
        <div className="topbar-right">
          <div className="avatar-stack">
            {room.members.slice(0, 4).map((m) => (
              <Avatar key={m.id} name={m.name} color={m.color} small />
            ))}
          </div>
          <span className="people-count">{room.members.filter((m) => m.online).length} online</span>
          <Button onClick={() => setModal('invite')}>
            <Users size={15} />
            Invite teammates
          </Button>
          <button
            className="icon-button exit"
            title="Leave room — your profile is remembered on this browser"
            aria-label="Leave room"
            onClick={leave}
          >
            <LogOut size={17} />
          </button>
        </div>
      </header>
      <div className="workspace-body">
        <nav className="side-nav" aria-label="Workspace navigation">
          <button
            aria-label="Workspace"
            title="Workspace"
            className={view === 'workspace' ? 'active' : ''}
            onClick={() => setView('workspace')}
          >
            <LayoutGrid size={20} />
          </button>
          <button
            aria-label="Changed files"
            title="Changed files"
            className={view === 'changes' ? 'active' : ''}
            onClick={() => setView('changes')}
          >
            <GitCompareArrows size={21} />
          </button>
          <button
            aria-label="Decision log"
            title="Decision log"
            className={view === 'decisions' ? 'active' : ''}
            onClick={() => setView('decisions')}
          >
            <Vote size={21} />
            {pending.length > 0 && <span className="nav-dot" />}
          </button>
          <div className="side-nav-spacer" />
          <button aria-label="Room details" title="Room details" onClick={() => setModal('invite')}>
            <CircleHelp size={20} />
          </button>
          <Avatar name={me.name} color={me.color} small />
        </nav>
        <div className="main-column">
          <section className="room-heading">
            <div>
              <div className="eyebrow">
                <span className={`dot ${enabled ? '' : 'amber'}`} />
                {enabled ? 'YOUR TEAM’S SHARED WORKSPACE' : 'RECONNECTING TO THE HOST'}
              </div>
              <h1>
                {room.name}
                <span className="heading-star">✳</span>
              </h1>
            </div>
            <div className="heading-actions">
              <button
                className="button secondary sidebar-toggle"
                aria-controls="team-sidebar"
                aria-expanded={!railCollapsed}
                onClick={() => setRailCollapsed(!railCollapsed)}
              >
                {railCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
                {railCollapsed ? 'Show sidebar' : 'Hide sidebar'}
                {pending.length > 0 && <span className="pending-count">{pending.length}</span>}
              </button>
              {room.mode === 'demo' && room.hostId === me.id && (
                <Button
                  onClick={() => {
                    showDecisions();
                    void action('/api/demo/scenario');
                  }}
                  disabled={!enabled || pending.some((d) => d.scope === 'team')}
                >
                  <Zap size={15} />
                  Run team scenario
                </Button>
              )}
              {room.mode === 'live' && (
                <Button onClick={() => setModal('runner')} disabled={!enabled}>
                  <Monitor size={16} />
                  Connect runner
                  {myRunners.some((runner) => runner.status === 'online') && (
                    <span className="runner-online-count">
                      {myRunners.filter((runner) => runner.status === 'online').length}
                    </span>
                  )}
                </Button>
              )}
              <Button
                kind="primary"
                onClick={openAgent}
                disabled={!enabled || room.agents.length >= 6}
              >
                <Plus size={17} />
                Add agent
              </Button>
            </div>
          </section>
          <div className="session-strip">
            <div>
              <span className="status-symbol">
                <Waves size={17} />
              </span>
              <strong>{room.agents.length} agents</strong>
              <span className="muted">in the room</span>
              <span className="strip-separator" />
              <span className="dot muted-dot" />
              {workingCount} working
            </div>
            <div>
              <FileCode2 size={14} />
              <span>{changedCount} files changed</span>
              <span className="strip-separator" />
              <GitBranch size={14} />
              <span>{room.branch}</span>
              <span className="strip-separator" />
              <Clock3 size={14} />
              <span>{Math.max(0, Math.floor((now - room.createdAt) / 60000))}m together</span>
            </div>
          </div>
          {pending.length > 0 && (
            <button
              className="mobile-decision-alert"
              onClick={() => {
                showDecisions();
              }}
            >
              <Vote size={16} />
              <span>
                {pending.length} {pending.length === 1 ? 'decision needs' : 'decisions need'}{' '}
                attention
              </span>
              <ArrowDown size={15} />
            </button>
          )}
          <div className={`content-with-rail ${railCollapsed ? 'rail-collapsed' : ''}`}>
            <main className="workspace-main">
              <div className="section-bar">
                <div className="view-tabs">
                  <button
                    className={view === 'workspace' ? 'active' : ''}
                    onClick={() => setView('workspace')}
                  >
                    <LayoutGrid size={15} />
                    Sessions<span>{room.agents.length}</span>
                  </button>
                  <button
                    className={view === 'changes' ? 'active' : ''}
                    onClick={() => setView('changes')}
                  >
                    Changes<span>{changedCount}</span>
                  </button>
                  <button
                    className={view === 'decisions' ? 'active' : ''}
                    onClick={() => setView('decisions')}
                  >
                    Decision log<span>{decisionHistory.length}</span>
                  </button>
                </div>
                {focus && (
                  <Button kind="ghost" onClick={() => setFocus(null)}>
                    Show all
                    <LayoutGrid size={14} />
                  </Button>
                )}
              </div>
              {room.overlaps.length > 0 && (
                <div className="overlap-banner">
                  <span className="overlap-icon">
                    <GitCompareArrows size={19} />
                  </span>
                  <div>
                    <strong>A little overlap. A good time to sync.</strong>
                    <p>
                      {room.overlaps.length} shared{' '}
                      {room.overlaps.length === 1 ? 'file has' : 'files have'} changes from multiple
                      agents.
                    </p>
                  </div>
                  <button
                    onClick={() => void showDiff(room.overlaps[0].path, room.overlaps[0].agentIds)}
                  >
                    Compare changes <ArrowUpRight size={15} />
                  </button>
                </div>
              )}
              {view === 'workspace' && (
                <>
                  <div className={`agent-grid ${focus ? 'focused' : ''}`}>
                    {agents.map((agent) => (
                      <AgentCard
                        key={agent.id}
                        agent={agent}
                        room={room}
                        session={session}
                        enabled={enabled}
                        action={action}
                        canClose={!!config?.closeSessions}
                        onClose={() => setClosingAgentId(agent.id)}
                        onFocus={() => setFocus(focus === agent.id ? null : agent.id)}
                        onFile={(file) => void showDiff(file, [agent.id])}
                        onQuestion={() => {
                          showDecisions();
                        }}
                      />
                    ))}
                    {!focus && room.agents.length < 6 && (
                      <button className="add-agent-card" onClick={openAgent} disabled={!enabled}>
                        <span className="add-agent-art">
                          <span className="dashed-orbit" />
                          <Plus size={24} />
                        </span>
                        <span>Give an agent a task.</span>
                        <span className="add-agent-link">
                          Add an agent <ArrowUpRight size={15} />
                        </span>
                      </button>
                    )}
                  </div>
                  <div className="workspace-caption">
                    <span>
                      <ShieldCheck size={14} />
                      {room.mode === 'demo'
                        ? 'Demo agents are simulated. No project files are changed.'
                        : 'Each agent works in its own Git worktree.'}
                    </span>
                  </div>
                </>
              )}
              {view === 'changes' && (
                <div className="changes-view">
                  <div className="view-intro">
                    <h2>The work, side by side.</h2>
                    <p>
                      File overlap is a signal to coordinate. It doesn’t always mean a conflict.
                    </p>
                  </div>
                  {changedCount === 0 && (
                    <Empty
                      icon={<FileCode2 />}
                      title="A clean slate."
                      text="Changed files will appear here as your agents work."
                    />
                  )}
                  {[...new Set(room.agents.flatMap((a) => a.files))].sort().map((file) => {
                    const owners = room.agents.filter((a) => a.files.includes(file));
                    return (
                      <button
                        className="change-row"
                        key={file}
                        onClick={() =>
                          void showDiff(
                            file,
                            owners.map((a) => a.id),
                          )
                        }
                      >
                        <FileCode2 size={17} />
                        <code>{file}</code>
                        <div>
                          {owners.map((a) => (
                            <span className={`agent-chip ${colors[a.color]}`} key={a.id}>
                              {a.name}
                            </span>
                          ))}
                        </div>
                        {owners.length > 1 && <span className="overlap-tag">Overlap</span>}
                        <ChevronRight size={16} />
                      </button>
                    );
                  })}
                </div>
              )}
              {view === 'decisions' && (
                <div className="decision-log">
                  <div className="view-intro">
                    <h2>One shared direction.</h2>
                    <p>
                      Settled team decisions are sent to active agents and included in future
                      prompts.
                    </p>
                  </div>
                  {decisionHistory.length === 0 ? (
                    <Empty
                      icon={<Vote />}
                      title="The next call is yours."
                      text="Start a team vote. Agreed decisions will be collected here."
                    />
                  ) : (
                    decisionHistory.map((d, i) => (
                      <div className="log-entry" key={d.id}>
                        <span className="log-number">
                          {String(decisionHistory.length - i).padStart(2, '0')}
                        </span>
                        <div>
                          <span className="eyebrow">
                            {d.status === 'cancelled'
                              ? 'CANCELLED BEFORE APPROVAL'
                              : `TEAM DECISION · ${formatTime(d.resolvedAt!)}`}
                          </span>
                          <h3>{d.question}</h3>
                          <p>
                            {d.status === 'cancelled' ? <X size={17} /> : <CheckCheck size={17} />}
                            {d.answer ?? 'This decision was cancelled. No answer was shared.'}
                          </p>
                          <details className="discussion-archive">
                            <summary>
                              <MessageSquare size={14} /> Discussion · {d.messages.length}
                            </summary>
                            <DecisionChat
                              decision={d}
                              room={room}
                              me={me.id}
                              action={action}
                              enabled={enabled}
                            />
                          </details>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </main>
            <aside id="team-sidebar" className="right-rail" hidden={railCollapsed}>
              <div className="rail-tabs">
                <button
                  className={rail === 'decisions' ? 'active' : ''}
                  onClick={() => setRail('decisions')}
                >
                  Team decisions{pending.length > 0 && <span>{pending.length}</span>}
                </button>
                <button
                  className={rail === 'activity' ? 'active' : ''}
                  onClick={() => setRail('activity')}
                >
                  Activity
                </button>
              </div>
              {rail === 'decisions' ? (
                <>
                  <div className="rail-intro">
                    <button
                      className="icon-button"
                      aria-label="Start a team vote"
                      onClick={() => setModal('decision')}
                      disabled={!enabled}
                    >
                      <Plus size={17} />
                    </button>
                  </div>
                  {pending.length === 0 ? (
                    <div className="no-decisions">
                      <div className="decision-art">
                        <MessageSquare size={27} />
                        <span>
                          <Check size={14} />
                        </span>
                      </div>
                      <h3>No pending decisions</h3>
                      <Button onClick={() => setModal('decision')} disabled={!enabled}>
                        <Plus size={15} />
                        Start a team vote
                      </Button>
                    </div>
                  ) : (
                    pending.map((d) => (
                      <DecisionCard
                        key={d.id}
                        decision={d}
                        room={room}
                        me={me.id}
                        now={now}
                        action={action}
                        enabled={enabled}
                      />
                    ))
                  )}
                  {settled.length > 0 && (
                    <div className="recent-decisions">
                      <span className="eyebrow">RECENTLY SETTLED</span>
                      {settled.slice(0, 3).map((d) => (
                        <button key={d.id} onClick={() => setView('decisions')}>
                          <CheckCheck size={16} />
                          <span>
                            {d.answer}
                            <small>{formatTime(d.resolvedAt!)}</small>
                          </span>
                          <ChevronRight size={14} />
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="activity-list">
                  {room.activity.map((a) => (
                    <div className={`activity-item ${a.kind}`} key={a.id}>
                      <span className="activity-dot" />
                      <div>
                        <p>{a.text}</p>
                        <time>{formatTime(a.at)}</time>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="room-bottom">
                <span className="eyebrow">IN THE ROOM</span>
                {room.members.map((m) => (
                  <div className="member-row" key={m.id}>
                    <Avatar name={m.name} color={m.color} small />
                    <span>
                      {m.name}
                      {m.id === me.id && <small> (you)</small>}
                    </span>
                    {m.id === room.hostId && <span className="host-label">HOST</span>}
                    <span
                      className={`dot ${m.online ? '' : 'muted-dot'}`}
                      title={m.online ? 'Online' : 'Offline'}
                    />
                  </div>
                ))}
                <button className="invite-text" onClick={() => setModal('invite')}>
                  <Plus size={14} />
                  Invite teammates
                </button>
              </div>
            </aside>
          </div>
        </div>
      </div>
      <footer className="statusbar">
        <span>
          <span className={`dot ${enabled ? '' : 'amber'}`} />
          {enabled ? 'Connected to host' : 'Connection lost · reconnecting…'}
        </span>
        <span>
          {room.mode === 'demo' ? 'SIMULATED AGENTS' : 'MULTIPLAYER SERVER'}
          <span className="statusbar-divider">/</span>ROOM {room.code}
        </span>
      </footer>
      {closingAgent && (
        <Modal
          title={`Close ${closingAgent.name}?`}
          close={() => {
            if (!busy) setClosingAgentId(null);
          }}
        >
          <p className="modal-description">
            This ends the agent conversation, cancels its pending decisions, and removes its card
            for everyone.
            {room.mode === 'live' && ' Its Git branch and worktree files will be kept.'}
          </p>
          {room.mode === 'live' && (
            <p className="form-note">
              Branch: <code>{closingAgent.branch}</code>
            </p>
          )}
          <div className="project-actions">
            <Button onClick={() => setClosingAgentId(null)} disabled={busy}>
              Keep session
            </Button>
            <Button kind="primary" onClick={() => void closeAgent()} disabled={busy || !enabled}>
              {busy ? <Loader2 className="spin" size={15} /> : <X size={15} />}
              {busy ? 'Closing…' : 'Close session'}
            </Button>
          </div>
        </Modal>
      )}
      {modal === 'invite' && (
        <Modal title="Invite teammates" eyebrow="INVITE YOUR TEAM" close={() => setModal(null)}>
          <p className="modal-description">
            Anyone with this invite can join the room, see agent sessions, and vote on team
            decisions.
          </p>
          <label>
            Room invite
            <div className="copy-field">
              <input
                readOnly
                value={`${location.origin}/?join=${room.code}`}
                onFocus={(e) => e.target.select()}
              />
              <button onClick={() => void copyInvite()} aria-label="Copy invite link">
                <Copy size={18} />
              </button>
            </div>
          </label>
          <div className="invite-code">
            <span className="eyebrow">OR SHARE THE ROOM CODE</span>
            <strong>
              {room.code.slice(0, 5)}
              <span> </span>
              {room.code.slice(5)}
            </strong>
          </div>
          {['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && (
            <div className="info-note">
              <Globe2 size={18} />
              <p>
                This is a local link. For teammates on another computer, start the host with{' '}
                <code>HOST=0.0.0.0 npm run dev</code> and share its LAN address. Everyone must be
                able to reach this server.
              </p>
            </div>
          )}
          <div className="modal-meta">
            <GitBranch size={15} />
            {room.repoName}
            <span>
              {room.mode === 'demo'
                ? 'Demo project'
                : config?.projects?.find((project) => project.id === room.projectId)?.path ||
                  room.branch}
            </span>
          </div>
        </Modal>
      )}
      {modal === 'agent' && (
        <Modal
          title="Another mind in the room."
          eyebrow="ADD AN AGENT"
          close={() => {
            if (!busy) setModal(null);
          }}
        >
          <p className="modal-description">
            Give this agent a clear responsibility. You’ll drive its session, and your team can
            follow along.
          </p>
          <form onSubmit={submitAgent}>
            {room.mode === 'live' && (
              <label>
                Run this agent on
                <select
                  value={selectedRunner}
                  onChange={(e) => {
                    setSelectedRunner(e.target.value);
                    setSelectedModel('');
                  }}
                  disabled={busy}
                >
                  <option value="" disabled={config?.codexAvailable === false}>
                    Server computer · Codex
                    {config?.codexAvailable === false ? ' (unavailable)' : ''}
                  </option>
                  {myRunners.map((runner) => (
                    <option key={runner.id} value={runner.id} disabled={runner.status !== 'online'}>
                      {runner.name} · {runner.harness === 'claude' ? 'Claude' : 'Codex'}
                      {runner.status !== 'online' ? ` (${runner.status})` : ''}
                    </option>
                  ))}
                </select>
                <span className="field-help">
                  {selectedRunner
                    ? 'Your local runner creates the worktree. Only you control this agent.'
                    : 'The room host’s Codex account runs this session.'}
                </span>
                {!myRunners.some((runner) => runner.status === 'online') && (
                  <button className="inline-link" type="button" onClick={() => setModal('runner')}>
                    Connect your own computer <ArrowUpRight size={13} />
                  </button>
                )}
              </label>
            )}
            {room.mode === 'live' && config?.modelSelection && (
              <ModelPicker
                key={selectedRunner}
                session={session}
                runnerId={selectedRunner}
                value={selectedModel}
                onChange={setSelectedModel}
                disabled={busy || !executionAvailable}
              />
            )}
            <label>
              Agent name
              <input
                placeholder="e.g. Interface"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={32}
                required
              />
            </label>
            <label>
              What will it work on?
              <textarea
                placeholder="e.g. Build the shared planning board and its interactions"
                value={task}
                onChange={(e) => setTask(e.target.value)}
                maxLength={300}
                rows={3}
                required
              />
            </label>
            <div className="info-note">
              <GitBranch size={18} />
              <p>
                {room.mode === 'demo'
                  ? 'This will add a simulated agent to your demo room.'
                  : selectedRunner
                    ? `We’ll start ${chosenRunner?.harness === 'claude' ? 'Claude' : 'Codex'} in a separate worktree on ${chosenRunner?.name ?? 'your computer'}. Send a prompt when you’re ready.`
                    : 'We’ll create a Git worktree on the server and connect a Codex session. Send a prompt when you’re ready to start.'}
              </p>
            </div>
            <Button
              className="full"
              type="submit"
              kind="primary"
              disabled={busy || !enabled || !executionAvailable}
            >
              {busy ? <Loader2 size={17} className="spin" /> : <Plus size={17} />}
              {busy ? 'Preparing the workspace…' : 'Add agent'}
            </Button>
          </form>
        </Modal>
      )}
      {modal === 'runner' && (
        <RunnerModal
          room={room}
          session={session}
          enabled={enabled}
          now={now}
          action={action}
          notify={notify}
          onError={onError}
          close={() => setModal(null)}
        />
      )}
      {modal === 'decision' && (
        <Modal
          title="Make the call together."
          eyebrow="START A TEAM VOTE"
          close={() => setModal(null)}
        >
          <p className="modal-description">
            Ask one clear question. Your team has 60 seconds to vote and discuss. You approve the
            final answer before it reaches the agents.
          </p>
          <form onSubmit={submitDecision}>
            <label>
              The decision
              <textarea
                placeholder="What should the team agree on?"
                rows={2}
                maxLength={500}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                required
              />
            </label>
            {choices.map((choice, i) => (
              <label key={i}>
                Option {String.fromCharCode(65 + i)}
                <input
                  placeholder={i === 0 ? 'One direction…' : 'Another direction…'}
                  value={choice}
                  onChange={(e) =>
                    setChoices(choices.map((c, j) => (i === j ? e.target.value : c)))
                  }
                  maxLength={300}
                  required={i < 2}
                />
              </label>
            ))}
            {choices.length < 4 && (
              <Button kind="ghost" onClick={() => setChoices([...choices, ''])}>
                <Plus size={14} />
                Add another option
              </Button>
            )}
            <Button kind="primary" className="full" type="submit" disabled={busy}>
              {busy ? <Loader2 className="spin" size={17} /> : <Vote size={17} />}Open the vote
            </Button>
          </form>
        </Modal>
      )}
      {diff && (
        <Modal
          wide
          title={diff.file}
          eyebrow={diff.agents.length > 1 ? 'COMPARE AGENT CHANGES' : 'FILE CHANGES'}
          close={() => setDiff(null)}
        >
          {diffLoading ? (
            <div className="loading-diff">
              <Loader2 className="spin" />
              Loading changes…
            </div>
          ) : (
            <>
              <p className="modal-description">
                {room.mode === 'demo'
                  ? 'Simulated changes for this demo.'
                  : 'Each diff compares the agent’s worktree with its starting commit.'}{' '}
                {diff.agents.length > 1 &&
                  'Review both versions before deciding how to combine them.'}
              </p>
              <div className="diff-columns">
                {diff.agents.map((a) => (
                  <div className="diff-panel" key={a.name}>
                    <header>
                      <GitBranch size={15} />
                      {a.name}
                    </header>
                    <pre>
                      {a.content.split('\n').map((line, i) => (
                        <span
                          className={
                            line.startsWith('+')
                              ? 'diff-add'
                              : line.startsWith('-')
                                ? 'diff-remove'
                                : line.startsWith('@@')
                                  ? 'diff-range'
                                  : ''
                          }
                          key={i}
                        >
                          {line || ' '}
                          <br />
                        </span>
                      ))}
                    </pre>
                  </div>
                ))}
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

function RunnerModal({
  room,
  session,
  enabled,
  now,
  action,
  notify,
  onError,
  close,
}: {
  room: Room;
  session: Session;
  enabled: boolean;
  now: number;
  action: Action;
  notify: (message: string) => void;
  onError: (message: string) => void;
  close: () => void;
}) {
  const [harness, setHarness] = useState<Harness>('codex');
  const [checkout, setCheckout] = useState<'repo' | 'clone'>('repo');
  const [pairing, setPairing] = useState<{
    code: string;
    expiresAt: number;
    project: RunnerProject;
  } | null>(null);
  const [busy, setBusy] = useState('');
  const runners = (room.runners ?? []).filter((runner) => runner.ownerId === session.memberId);
  const project = pairing?.project ?? room.project;
  const seconds = pairing
    ? Math.min(600, Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)))
    : 0;
  // Every interpolated argument is restricted to a non-executable alphabet. The path
  // stays a literal placeholder so no user-supplied path can become shell syntax.
  const safeOrigin = /^https?:\/\/[a-z0-9.:[\]-]+(?::\d+)?$/i.test(location.origin)
    ? location.origin
    : '';
  const safeCode = pairing && /^[a-z0-9-]+$/i.test(pairing.code) ? pairing.code : '';
  const command =
    pairing && safeOrigin && safeCode
      ? `npm run runner -- --server "${safeOrigin}" --pair "${safeCode}" --${checkout} "./project"`
      : '';
  async function generate() {
    if (!enabled) return;
    setBusy('pair');
    try {
      setPairing(await api('/api/runners/pair', session, { harness }));
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      notify('Runner command copied. Replace ./project with your local path before running.');
    } catch {
      onError('Clipboard unavailable. Select and copy the command below.');
    }
  }
  async function revoke(id: string) {
    setBusy(id);
    if (await action(`/api/runners/${id}/revoke`)) notify('Runner disconnected');
    setBusy('');
  }
  return (
    <Modal title="Your machine. Your harness." eyebrow="CONNECT A LOCAL RUNNER" close={close}>
      <p className="modal-description">
        Run agents in local Git worktrees with your own credentials. Your teammates follow the
        public session in this room.
      </p>
      <div className="runner-setup-note">
        <Monitor size={20} />
        <p>
          On your computer, install Node.js 22+ and Git, clone the{' '}
          <a
            href="https://github.com/EyedBread/multiplayer-agentic-coding"
            target="_blank"
            rel="noreferrer"
          >
            Multiplayer app
          </a>
          , and run <code>npm install</code> in its folder. Keep the runner terminal open while you
          work.
        </p>
      </div>
      <label>
        Your harness
        <select
          value={harness}
          disabled={!!busy}
          onChange={(event) => {
            setHarness(event.target.value as Harness);
            setPairing(null);
          }}
        >
          <option value="codex">Codex</option>
          <option value="claude">Claude Code</option>
        </select>
        <span className="field-help">
          {harness === 'codex'
            ? 'Sign in to Codex on this computer first. The runner uses your local login.'
            : 'Use your local Claude login, ANTHROPIC_API_KEY, or supported provider credentials.'}
        </span>
      </label>
      <label>
        Project checkout
        <select
          value={checkout}
          onChange={(event) => setCheckout(event.target.value as 'repo' | 'clone')}
        >
          <option value="repo">Use a repository already on this computer</option>
          <option value="clone" disabled={!project?.remoteUrl}>
            Clone the room’s repository into a new folder
          </option>
        </select>
        <span className="field-help">
          {checkout === 'clone'
            ? `The runner clones ${project?.identity || room.repoName} using your local Git credentials.`
            : `Use an existing checkout of ${room.repoName}. The runner checks the repository and starting commit.`}
        </span>
      </label>
      {pairing ? (
        <div className="runner-pairing">
          <div className="runner-pairing-heading">
            <span className="eyebrow">RUN IN YOUR MULTIPLAYER APP FOLDER</span>
            <span className={seconds ? '' : 'expired'}>
              <Clock3 size={12} />
              {seconds
                ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
                : 'Expired'}
            </span>
          </div>
          <textarea
            className="runner-command"
            aria-label="Runner pairing command"
            readOnly
            value={command || 'Unable to create a safe command for this server address.'}
            rows={4}
            onFocus={(event) => event.target.select()}
          />
          <p className="form-note">
            Replace <code>./project</code> with{' '}
            {checkout === 'clone' ? 'a new empty folder path' : 'your local repository path'}. This
            single-use code expires after 10 minutes. It connects only your runner to this room.
          </p>
          <div className="runner-command-actions">
            <Button
              kind="primary"
              disabled={!seconds || !command || !enabled}
              onClick={() => void copy()}
            >
              <Copy size={15} /> Copy command
            </Button>
            <Button kind="ghost" disabled={!!busy || !enabled} onClick={() => void generate()}>
              {busy === 'pair' ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}{' '}
              New code
            </Button>
          </div>
        </div>
      ) : (
        <Button
          className="full runner-pair-button"
          kind="primary"
          disabled={!!busy || !enabled}
          onClick={() => void generate()}
        >
          {busy === 'pair' ? <Loader2 size={16} className="spin" /> : <Link2 size={16} />} Create
          pairing command
        </Button>
      )}
      <section className="runner-list" aria-label="Your connected runners">
        <div className="runner-list-heading">
          <span className="eyebrow">YOUR RUNNERS</span>
          <span>{runners.length}</span>
        </div>
        {runners.length ? (
          runners.map((runner) => (
            <div className="runner-row" key={runner.id}>
              <Monitor size={18} />
              <div>
                <strong>{runner.name}</strong>
                <span>
                  {runner.harness === 'claude' ? 'Claude' : 'Codex'}{' '}
                  <span className={`runner-status ${runner.status}`}>{runner.status}</span>
                </span>
              </div>
              <button
                className="button ghost"
                type="button"
                disabled={!!busy || !enabled}
                onClick={() => void revoke(runner.id)}
                aria-label={`Disconnect ${runner.name}`}
              >
                {busy === runner.id ? <Loader2 size={13} className="spin" /> : <X size={13} />}{' '}
                Disconnect
              </button>
            </div>
          ))
        ) : (
          <p className="form-note">
            Your computer will appear here when the runner connects. Then choose it when adding an
            agent.
          </p>
        )}
        {runners.length > 0 && (
          <p className="form-note">
            Disconnecting stops this runner’s agent sessions. Their local worktrees stay on your
            computer.
          </p>
        )}
      </section>
    </Modal>
  );
}

function Empty({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="empty-state">
      {icon}
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

function AgentCard({
  agent,
  room,
  session,
  enabled,
  action,
  onFocus,
  onFile,
  onQuestion,
  canClose,
  onClose,
}: {
  agent: Agent;
  room: Room;
  session: Session;
  enabled: boolean;
  action: Action;
  onFocus: () => void;
  onFile: (file: string) => void;
  onQuestion: () => void;
  canClose: boolean;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [tab, setTab] = useState<'session' | 'files'>('session');
  const [busy, setBusy] = useState(false);
  const [follow, setFollow] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const owner = room.members.find((m) => m.id === agent.ownerId);
  const canControl =
    session.memberId === agent.ownerId || (!agent.runnerId && session.memberId === room.hostId);
  const runner = (room.runners ?? []).find((item) => item.id === agent.runnerId);
  const canPrompt = agent.status === 'idle' || (agent.status === 'error' && !agent.error);
  const waiting = room.decisions.some((d) => d.agentId === agent.id && activeDecision(d));
  useEffect(() => {
    if (follow && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [agent.entries, follow]);
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;
    setBusy(true);
    if (await action(`/api/agents/${agent.id}/prompt`, { prompt })) {
      setPrompt('');
      setFollow(true);
    }
    setBusy(false);
  }
  async function restart() {
    if (busy || !canControl || runner?.status !== 'online') return;
    setBusy(true);
    await action(`/api/agents/${agent.id}/restart`);
    setBusy(false);
  }
  return (
    <article className={`agent-card ${colors[agent.color]}`}>
      <header className="agent-header">
        <span className="agent-glyph">
          <Command size={20} />
        </span>
        <div className="agent-title">
          <h2>
            {agent.name}
            <span>{agent.harness === 'claude' ? 'Claude' : 'Codex'}</span>
          </h2>
          <p>
            {room.mode === 'demo' ? 'Demo session' : owner?.name || 'Teammate'}
            <span>·</span>
            {room.mode === 'live' && (
              <>
                <span className="agent-device" title={runner?.name}>
                  {agent.runnerId ? runner?.name || 'Local runner' : 'Server'}
                </span>
                <span>·</span>
              </>
            )}
            {agent.branch}
          </p>
          {room.mode === 'live' && (
            <p title="Selected model">Model: {agent.model || 'Harness default'}</p>
          )}
        </div>
        <button
          className="icon-button"
          title="Focus session"
          aria-label={`Focus ${agent.name} session`}
          onClick={onFocus}
        >
          <ArrowUpRight size={17} />
        </button>
        {canClose && canControl && (
          <button
            className="icon-button"
            title="Close session"
            aria-label={`Close ${agent.name} session`}
            onClick={onClose}
            disabled={!enabled || busy || ['starting', 'closing'].includes(agent.status)}
          >
            <X size={17} />
          </button>
        )}
      </header>
      <div className="agent-task">
        <span className={`agent-status ${agent.status}`}>
          <span className="dot" />
          {
            {
              idle: 'Ready',
              working: 'Working',
              waiting: 'Needs input',
              starting: 'Connecting',
              error: 'Error',
              offline: 'Runner offline',
              closing: 'Closing',
            }[agent.status]
          }
        </span>
        <span title={agent.task}>{agent.task}</span>
      </div>
      <div className="agent-tabs">
        <button className={tab === 'session' ? 'active' : ''} onClick={() => setTab('session')}>
          <Terminal size={13} />
          Session
        </button>
        <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>
          <FileCode2 size={13} />
          Files<span>{agent.files.length}</span>
        </button>
        <span className="agent-tabs-end">{room.mode === 'demo' ? 'SIMULATED' : 'LIVE'}</span>
      </div>
      {tab === 'session' ? (
        <div
          className="agent-transcript"
          ref={scroll}
          onScroll={() => {
            const el = scroll.current;
            if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
          }}
        >
          {agent.entries.length === 0 && (
            <div className="agent-welcome">
              <Sparkles size={25} />
              <h3>Ready when you are.</h3>
              <p>
                Send the first prompt below.
                <br />
                Your team can follow along.
              </p>
            </div>
          )}
          {agent.entries.map((item) => (
            <div className={`entry ${item.kind}`} key={item.id}>
              {item.kind === 'user' ? (
                <>
                  <span className="entry-label">PROMPT</span>
                  <p>{item.text}</p>
                </>
              ) : item.kind === 'command' ? (
                <details>
                  <summary>
                    <Terminal size={13} />
                    <span>{item.text.split('\n')[0]}</span>
                    <ChevronRight size={12} />
                  </summary>
                  {item.text.includes('\n') && (
                    <pre>{item.text.slice(item.text.indexOf('\n') + 1)}</pre>
                  )}
                </details>
              ) : item.kind === 'system' ? (
                <p>
                  <CheckCheck size={13} />
                  <span>{item.text}</span>
                </p>
              ) : (
                <>
                  <span className="entry-label">
                    {item.kind === 'error' ? (
                      'SOMETHING NEEDS ATTENTION'
                    ) : (
                      <>
                        <span className="codex-tiny">✳</span>{' '}
                        {agent.harness === 'claude' ? 'CLAUDE' : 'CODEX'}
                      </>
                    )}
                  </span>
                  <p>{item.text}</p>
                </>
              )}
            </div>
          ))}
          {agent.status === 'working' && (
            <div className="thinking">
              <span />
              <span />
              <span />
              <small>Working on it</small>
            </div>
          )}
          {waiting && (
            <button className="waiting-callout" onClick={onQuestion}>
              <Vote size={16} />
              <span>A decision is waiting for you</span>
              <ArrowUpRight size={15} />
            </button>
          )}
        </div>
      ) : (
        <div className="agent-files">
          {!agent.files.length && (
            <Empty
              icon={<FileCode2 size={22} />}
              title="No changes yet."
              text="Files will appear as this agent works."
            />
          )}
          {agent.files.map((file) => (
            <button key={file} onClick={() => onFile(file)}>
              <FileCode2 size={14} />
              <span>{file}</span>
              {room.overlaps.some((o) => o.path === file) ? (
                <GitCompareArrows size={14} className="overlap-file" />
              ) : (
                <span className="file-modified">M</span>
              )}
            </button>
          ))}
        </div>
      )}
      {agent.runnerId && ['error', 'offline'].includes(agent.status) && (
        <div className="agent-recovery" role="status">
          <p>
            {agent.status === 'offline'
              ? `${canControl ? 'Keep your' : `${owner?.name ?? 'The owner'} needs to keep their`} runner terminal open. Use its saved resume command to reconnect.`
              : 'Restart the conversation in the same worktree. Your file changes stay intact.'}
          </p>
          {agent.status === 'error' && canControl && (
            <button
              type="button"
              disabled={!enabled || busy || runner?.status !== 'online'}
              onClick={() => void restart()}
            >
              {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
              Restart session
            </button>
          )}
        </div>
      )}
      <div className="agent-input-wrap">
        <form className="agent-input" onSubmit={send}>
          <input
            aria-label={`Message ${agent.name}`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              !canControl
                ? `${owner?.name} is driving this session`
                : agent.status === 'waiting'
                  ? 'Waiting for a decision…'
                  : agent.status === 'offline'
                    ? 'Reconnect your runner to continue…'
                    : 'Give your agent a direction…'
            }
            disabled={!enabled || !canControl || !canPrompt || busy}
            maxLength={12000}
          />
          <button
            type="submit"
            aria-label={`Send message to ${agent.name}`}
            disabled={!enabled || !canControl || !canPrompt || !prompt.trim() || busy}
          >
            {busy ? <Loader2 size={16} className="spin" /> : <ArrowUp size={17} />}
          </button>
        </form>
        <div className="agent-footer">
          <span>
            <GitBranch size={12} />
            {room.mode === 'demo' ? 'Demo worktree' : 'Isolated worktree'}
          </span>
          {canControl && ['working', 'waiting'].includes(agent.status) ? (
            <button onClick={() => void action(`/api/agents/${agent.id}/stop`)} disabled={!enabled}>
              <Square size={10} />
              Stop
            </button>
          ) : (
            <span title="Version of shared decisions delivered to this agent">
              {agent.contextVersion >= room.decisionVersion ? (
                <CheckCheck size={12} />
              ) : (
                <Clock3 size={12} />
              )}
              {agent.contextVersion >= room.decisionVersion ? 'Up to date' : 'Decision queued'}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

function DecisionCard({
  decision: d,
  room,
  me,
  now,
  action,
  enabled,
}: {
  decision: Decision;
  room: Room;
  me: string;
  now: number;
  action: Action;
  enabled: boolean;
}) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const seconds = Math.min(
    VOTE_DURATION_MS / 1000,
    Math.max(0, Math.ceil(((d.closesAt ?? now) - now) / 1000)),
  );
  const canResolve = d.ownerId === me && (d.scope !== 'team' || d.status === 'owner-needed');
  const canVote =
    d.scope === 'team' && d.status === 'open' && seconds > 0 && d.eligible.includes(me);
  const agent = room.agents.find((a) => a.id === d.agentId);
  const owner = room.members.find((m) => m.id === d.ownerId);
  const voteCount = Object.keys(d.votes).length;
  const counts = d.options.map(
    (_, index) => Object.values(d.votes).filter((v) => v === index).length,
  );
  const max = Math.max(0, ...counts);
  const winner =
    max > 0 && counts.filter((count) => count === max).length === 1 ? counts.indexOf(max) : null;
  async function approve(value: string) {
    setBusy(true);
    await action(`/api/decisions/${d.id}/resolve`, { answer: value });
    setBusy(false);
  }
  return (
    <div className={`decision-card ${d.scope}`}>
      <div className="decision-top">
        <span>
          <span className="dot" />
          {d.scope === 'team'
            ? 'TEAM VOTE'
            : d.scope === 'approval'
              ? agent?.runnerId
                ? 'OWNER APPROVAL'
                : 'HOST APPROVAL'
              : 'OWNER QUESTION'}
        </span>
        {d.scope === 'team' && (
          <span className="countdown">
            <Clock3 size={12} />
            {d.status === 'owner-needed' ? 'Awaiting approval' : `${seconds}s`}
          </span>
        )}
      </div>
      <h3>{d.question}</h3>
      {d.detail && <p className="decision-detail">{d.detail}</p>}
      <div className="decision-source">
        {agent && <span className={`source-dot ${colors[agent.color]}`} />}
        {agent ? `${agent.name} is waiting · ` : ''}
        {owner?.name} makes the final call
      </div>
      <div className="vote-options">
        {d.options.map((option, index) => (
          <button
            key={option}
            className={
              (canResolve && d.scope === 'team' ? answer === option : d.votes[me] === index)
                ? 'voted'
                : ''
            }
            aria-pressed={
              canResolve && d.scope === 'team' ? answer === option : d.votes[me] === index
            }
            disabled={!enabled || busy || (!canVote && !canResolve)}
            onClick={() => {
              if (canVote) void action(`/api/decisions/${d.id}/vote`, { option: index });
              else if (d.scope === 'team') setAnswer(option);
              else void approve(option);
            }}
          >
            <span className="option-letter">{String.fromCharCode(65 + index)}</span>
            <span>{option}</span>
            {d.scope === 'team' && (
              <span className="option-count">
                {counts[index]}
                {d.votes[me] === index && <Check size={12} />}
              </span>
            )}
          </button>
        ))}
      </div>
      {d.options.length === 0 && canResolve && (
        <form
          className="answer-form"
          onSubmit={(e) => {
            e.preventDefault();
            void approve(answer);
          }}
        >
          <input
            aria-label="Your answer"
            placeholder="Your answer…"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            required
            maxLength={3000}
          />
          <button
            className="icon-button"
            type="submit"
            aria-label="Send answer"
            disabled={!enabled || busy}
          >
            <Send size={16} />
          </button>
        </form>
      )}
      {d.scope === 'team' && (
        <>
          <div className="vote-progress">
            <span
              style={{
                width: `${Math.min(100, ((VOTE_DURATION_MS / 1000 - seconds) / (VOTE_DURATION_MS / 1000)) * 100)}%`,
              }}
            />
          </div>
          <div className="vote-footer">
            <span>
              {voteCount} / {d.eligible.length} voted
            </span>
            <span>
              {d.status === 'owner-needed'
                ? 'Voting closed'
                : d.votes[me] !== undefined
                  ? 'Your vote is in ✓'
                  : canVote
                    ? 'Your voice counts'
                    : 'Watching this vote'}
            </span>
          </div>
          {d.status === 'owner-needed' && (
            <div className="owner-review" role="status">
              <span className="eyebrow">
                <Clock3 size={13} /> PAUSED FOR {owner?.name.toUpperCase()}
              </span>
              <p>
                {winner === null ? 'No clear winner.' : `Team preference: ${d.options[winner]}.`}{' '}
                {canResolve
                  ? 'Select the final answer above, then approve when you’re ready.'
                  : `Waiting for ${owner?.name} to approve the final answer.`}
              </p>
              {canResolve && (
                <Button
                  kind="primary"
                  className="full"
                  disabled={!enabled || busy || !answer}
                  onClick={() => void approve(answer)}
                >
                  {busy ? <Loader2 size={15} className="spin" /> : <CheckCheck size={15} />}
                  {agent ? 'Approve & resume agent' : 'Approve & share decision'}
                </Button>
              )}
            </div>
          )}
          <DecisionChat decision={d} room={room} me={me} action={action} enabled={enabled} />
        </>
      )}
      {d.scope === 'owner' && d.options.length >= 2 && (
        <button
          className="promote-button"
          disabled={!enabled || busy}
          onClick={() => void action(`/api/decisions/${d.id}/promote`)}
        >
          <Users size={13} />
          Ask the whole team
          <ArrowUpRight size={13} />
        </button>
      )}
      {d.scope === 'approval' && (
        <p className="approval-note">
          <ShieldCheck size={12} />
          {agent?.runnerId ? 'The agent owner' : 'The room host'} must explicitly approve this
          action.
        </p>
      )}
    </div>
  );
}

function DecisionChat({
  decision,
  room,
  me,
  action,
  enabled,
}: {
  decision: Decision;
  room: Room;
  me: string;
  action: Action;
  enabled: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const writable = activeDecision(decision);
  useEffect(() => {
    if (list.current && stickToBottom.current) list.current.scrollTop = list.current.scrollHeight;
  }, [decision.messages.length, decision.messages.at(-1)?.id]);
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!draft.trim() || busy) return;
    setBusy(true);
    if (await action(`/api/decisions/${decision.id}/chat`, { text: draft })) {
      setDraft('');
      stickToBottom.current = true;
    }
    setBusy(false);
  }
  return (
    <section className="decision-chat" aria-label={`Discussion: ${decision.question}`}>
      <div className="chat-heading">
        <MessageSquare size={13} />
        <strong>Talk it through</strong>
        <span>{decision.messages.length}</span>
      </div>
      <div
        className="chat-messages"
        role="log"
        aria-label="Discussion messages"
        aria-live="polite"
        ref={list}
        onScroll={() => {
          const el = list.current;
          if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
        }}
      >
        {decision.messages.length === 0 && (
          <p className="chat-empty">Make your case. This conversation belongs to this vote.</p>
        )}
        {decision.messages.map((message) => {
          const member = room.members.find((m) => m.id === message.memberId);
          return (
            <div
              className={`chat-message ${message.memberId === me ? 'mine' : ''}`}
              key={message.id}
            >
              <div>
                <span className={`chat-author ${colors[member?.color ?? 0]}`}>
                  {member?.name ?? 'Teammate'}
                </span>
                <time dateTime={new Date(message.at).toISOString()}>{formatTime(message.at)}</time>
              </div>
              <p>{message.text}</p>
            </div>
          );
        })}
      </div>
      {writable ? (
        <form className="chat-compose" onSubmit={send}>
          <input
            aria-label={`Message about ${decision.question}`}
            placeholder="Share your thinking…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={1000}
            disabled={!enabled || busy}
          />
          <button
            type="submit"
            aria-label={`Send discussion message about ${decision.question}`}
            disabled={!enabled || busy || !draft.trim()}
          >
            {busy ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
          </button>
        </form>
      ) : (
        <p className="chat-closed">Discussion saved · read-only</p>
      )}
    </section>
  );
}

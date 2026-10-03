import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronRight,
  Code2,
  FileCode2,
  GitCompareArrows,
  Pause,
  Play,
  RotateCcw,
  Terminal,
  Vote,
} from 'lucide-react';
import './LandingPreview.css';

const tabs = ['Sessions', 'Decision', 'Files'] as const;
type Tab = (typeof tabs)[number];
const agents = [
  { name: 'Codex', person: 'Alex', task: 'Build the board', color: 'lime' },
  { name: 'Claude', person: 'Mina', task: 'Connect presence', color: 'lavender' },
];
const activity = [
  [
    'Reading Board.tsx',
    'Adding drag-and-drop',
    'Updating board events',
    'Checking interaction tests',
  ],
  [
    'Reading presence.ts',
    'Connecting room updates',
    'Adding presence events',
    'Checking reconnect behavior',
  ],
];
const files = [
  {
    name: 'shared/events.ts',
    owners: [0, 1],
    notes: ['Defines board events', 'Adds presence events'],
  },
  { name: 'src/Board.tsx', owners: [0], notes: ['Builds the planning board'] },
  { name: 'server/presence.ts', owners: [1], notes: ['Connects teammate presence'] },
];

export function LandingPreview() {
  const id = useId();
  const [tab, setTab] = useState<Tab>('Sessions');
  const [agent, setAgent] = useState(0);
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(
    () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [choice, setChoice] = useState<number | null>(null);
  const [approved, setApproved] = useState(false);
  const [file, setFile] = useState(0);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => {
      if (media.matches) setPlaying(false);
    };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      if (!document.hidden) setTick((value) => (value + 1) % 4);
    }, 2400);
    return () => clearInterval(timer);
  }, [playing]);
  function switchTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % 3
        : event.key === 'ArrowLeft'
          ? (index + 2) % 3
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? 2
              : -1;
    if (next < 0) return;
    event.preventDefault();
    setTab(tabs[next]);
    (
      event.currentTarget.parentElement?.querySelectorAll('button')[next] as HTMLButtonElement
    )?.focus();
  }
  const waiting = agent === 1 && !approved;
  return (
    <section
      className={`landing-preview ${playing ? 'is-playing' : ''}`}
      aria-label="Interactive workspace preview"
    >
      <header className="preview-heading">
        <span>
          <span className="preview-indicator" /> Interactive preview <small>SIMULATED</small>
        </span>
        <div>
          <button
            type="button"
            aria-label={playing ? 'Pause preview' : 'Play preview'}
            title={playing ? 'Pause preview' : 'Play preview'}
            onClick={() => setPlaying(!playing)}
          >
            {playing ? <Pause size={13} /> : <Play size={13} />}
          </button>
          <button
            type="button"
            aria-label="Reset preview"
            title="Reset preview"
            onClick={() => {
              setTick(0);
              setChoice(null);
              setApproved(false);
              setTab('Sessions');
              setAgent(0);
              setFile(0);
            }}
          >
            <RotateCcw size={13} />
          </button>
        </div>
      </header>
      <div className="preview-agents">
        {agents.map((item, index) => (
          <button
            key={item.name}
            type="button"
            className={`preview-agent ${item.color} ${agent === index ? 'selected' : ''}`}
            aria-label={`Show ${item.name} session`}
            aria-pressed={agent === index}
            onClick={() => {
              setAgent(index);
              setTab('Sessions');
            }}
          >
            <span className="preview-agent-title">
              <Code2 size={16} />
              <strong>{item.name}</strong>
              <span>{item.person}</span>
            </span>
            <span className="preview-task">{item.task}</span>
            <span className={`preview-agent-status ${index === 1 && !approved ? 'waiting' : ''}`}>
              {index === 1 && !approved ? (
                <Vote size={11} />
              ) : (
                <span className="preview-indicator" />
              )}
              {index === 1 && !approved ? 'Needs a decision' : 'Working'}
            </span>
          </button>
        ))}
      </div>
      <div className="preview-tabs" role="tablist" aria-label="Preview views">
        {tabs.map((item, index) => (
          <button
            key={item}
            type="button"
            role="tab"
            id={`${id}-tab-${index}`}
            aria-controls={`${id}-panel-${index}`}
            aria-selected={tab === item}
            tabIndex={tab === item ? 0 : -1}
            onKeyDown={(event) => switchTab(event, index)}
            onClick={() => setTab(item)}
          >
            {index === 0 ? (
              <Terminal size={13} />
            ) : index === 1 ? (
              <Vote size={13} />
            ) : (
              <GitCompareArrows size={13} />
            )}
            {item}
            <span className={index === 1 && !approved ? 'attention' : ''}>
              {index === 0 ? 2 : index === 1 ? approved ? <Check size={10} /> : 1 : 3}
            </span>
          </button>
        ))}
      </div>
      <div
        className="preview-panel"
        role="tabpanel"
        id={`${id}-panel-${tabs.indexOf(tab)}`}
        aria-labelledby={`${id}-tab-${tabs.indexOf(tab)}`}
        tabIndex={0}
      >
        {tab === 'Sessions' && (
          <div className="preview-session">
            <div className="preview-panel-label">
              <span>
                {agents[agent].name} <span className="preview-slash">/</span> {agents[agent].task}
              </span>
              <span className="preview-terminal-dots">···</span>
            </div>
            <div className="preview-code-line">
              <ChevronRight size={12} />
              <code>{agent === 0 ? 'src/Board.tsx' : 'server/presence.ts'}</code>
              <span>+{waiting ? 12 : 12 + tick * 7} −2</span>
            </div>
            <div className="preview-output" key={`${agent}-${waiting ? 'waiting' : tick}`}>
              <span className={agents[agent].color}>✳</span>
              <p>
                {waiting
                  ? 'The board and presence need the same event format. Let’s decide together.'
                  : `${activity[agent][tick]}.`}
              </p>
            </div>
            <div className="preview-session-bottom">
              {approved ? (
                <span className="preview-approved">
                  <CheckCheck size={13} /> Team decision received
                </span>
              ) : (
                <button type="button" onClick={() => setTab('Decision')}>
                  Choose the shared event format <ArrowRight size={13} />
                </button>
              )}
              <span className="preview-progress" aria-hidden="true">
                {[0, 1, 2, 3].map((step) => (
                  <i key={step} className={step <= tick && !waiting ? 'filled' : ''} />
                ))}
              </span>
            </div>
          </div>
        )}
        {tab === 'Decision' && (
          <div className="preview-decision">
            <div className="preview-panel-label">
              <span>TEAM DECISION</span>
              <span>{approved ? 'Approved by you' : 'Try a vote'}</span>
            </div>
            <h3>How should we send board updates?</h3>
            <div className="preview-choices">
              {['Typed events', 'Full snapshots'].map((option, index) => {
                const votes = (index === 0 ? 1 : 0) + (choice === index ? 1 : 0);
                return (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={choice === index}
                    disabled={approved}
                    onClick={() => setChoice(index)}
                  >
                    <span>{choice === index ? <Check size={12} /> : index === 0 ? 'A' : 'B'}</span>
                    {option}
                    <small>
                      {votes} {votes === 1 ? 'vote' : 'votes'}
                    </small>
                  </button>
                );
              })}
            </div>
            <div className="preview-decision-bottom">
              <span>
                {approved ? 'Shared with both agents.' : 'Team votes. Session owner approves.'}
              </span>
              {approved ? (
                <button
                  type="button"
                  onClick={() => {
                    setAgent(1);
                    setTab('Sessions');
                  }}
                >
                  See Claude resume <ArrowRight size={12} />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={choice === null}
                  onClick={() => {
                    setApproved(true);
                    setTick(0);
                  }}
                >
                  Approve & resume <ArrowRight size={12} />
                </button>
              )}
            </div>
          </div>
        )}
        {tab === 'Files' && (
          <div className="preview-files">
            <div className="preview-panel-label">
              <span>TOUCHED FILES</span>
              <span className="preview-overlap-text">1 overlap</span>
            </div>
            {files.map((item, index) => (
              <button
                type="button"
                key={item.name}
                aria-pressed={file === index}
                aria-label={`Inspect ${item.name}`}
                onClick={() => setFile(index)}
              >
                <FileCode2 size={13} />
                <code>{item.name}</code>
                <span>
                  {item.owners.map((owner) => (
                    <small className={agents[owner].color} key={owner}>
                      {agents[owner].name}
                    </small>
                  ))}
                </span>
              </button>
            ))}
            <div className="preview-file-detail">
              {files[file].owners.map((owner, index) => (
                <span key={owner}>
                  <i className={agents[owner].color} />
                  {agents[owner].name}: {files[file].notes[index]}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
      <button
        type="button"
        className="preview-overlap"
        onClick={() => {
          setFile(0);
          setTab('Files');
        }}
      >
        <GitCompareArrows size={14} />
        <span>
          <code>shared/events.ts</code> touched by both agents
        </span>
        <ArrowRight size={13} />
      </button>
    </section>
  );
}

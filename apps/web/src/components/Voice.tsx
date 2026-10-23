import { Mic, MicOff, Square, Volume2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from './ui';

// Voice: dictation with the browser's own speech recognition (Chrome, Edge, Safari; audio never reaches Nimbus),
// and answers read aloud with the browser's speech synthesis. Where a browser has neither, the buttons don't show.

type Recognition = {
  lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void; stop: () => void; abort: () => void;
};
const Ctor = (): (new () => Recognition) | undefined =>
  typeof window === 'undefined' ? undefined : ((window as unknown as Record<string, unknown>).SpeechRecognition ?? (window as unknown as Record<string, unknown>).webkitSpeechRecognition) as (new () => Recognition) | undefined;

export const canListen = () => !!Ctor();
export const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

const ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone access is blocked. Allow the microphone for this site in your browser (the icon in the address bar).',
  'service-not-allowed': 'Microphone access is blocked. Allow the microphone for this site in your browser.',
  'audio-capture': 'No microphone was found.',
  network: "Speech recognition needs an internet connection.",
};

/** Listen once: interim text while speaking, the final text when done. */
export function useListen(onFinal: (text: string) => void, onInterim?: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);
  const final = useRef(onFinal); final.current = onFinal;
  const interim = useRef(onInterim); interim.current = onInterim;
  useEffect(() => () => rec.current?.abort(), []);
  const start = () => {
    const C = Ctor();
    if (!C) { toast('Voice input works in Chrome, Edge and Safari.', 'bad'); return; }
    if (rec.current) { rec.current.stop(); return; }
    const r = new C();
    r.lang = navigator.language || 'en-US';
    r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
    let text = '';
    r.onresult = (e) => {
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) text += t; else live += t;
      }
      interim.current?.((text + live).trim());
    };
    r.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') toast(ERRORS[e.error] ?? `Voice input stopped (${e.error}).`, 'bad'); };
    r.onend = () => { rec.current = null; setListening(false); if (text.trim()) final.current(text.trim()); };
    rec.current = r;
    setListening(true);
    try { r.start(); } catch { rec.current = null; setListening(false); }
  };
  const stop = () => rec.current?.stop();
  return { listening, start, stop, supported: canListen() };
}

/** A microphone button that types what you say into a field (appending to what's there). */
export function MicButton({ value, onChange, onDone, label = 'Speak instead of typing', className = 'ghost icon' }: {
  value: string; onChange: (v: string) => void; onDone?: (v: string) => void; label?: string; className?: string;
}) {
  const base = useRef('');
  const { listening, start, supported } = useListen(
    (t) => { const v = join(base.current, t); onChange(v); onDone?.(v); },
    (t) => onChange(join(base.current, t)),
  );
  if (!supported) return null;
  return (
    <button type="button" className={className + (listening ? ' listening' : '')} aria-label={listening ? 'Stop listening' : label} title={listening ? 'Listening… click to stop' : label} aria-pressed={listening}
      onClick={() => { if (!listening) base.current = value; start(); }}>
      {listening ? <MicOff size={15} /> : <Mic size={15} />}
    </button>
  );
}
const join = (a: string, b: string) => (a.trim() ? `${a.trim()} ${b}` : b);

/** Markdown and links read as plain sentences. Pure; tested. */
export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_`>|]/g, '')
    .replace(/\[(\d+)\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

let speakingId = 0;
export function speak(text: string, onEnd?: () => void): number {
  if (!canSpeak()) return 0;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(speakable(text).slice(0, 4000));
  u.lang = navigator.language || 'en-US';
  const id = ++speakingId;
  u.onend = () => { if (id === speakingId) onEnd?.(); };
  u.onerror = () => { if (id === speakingId) onEnd?.(); };
  window.speechSynthesis.speak(u);
  return id;
}
export const stopSpeaking = () => { if (canSpeak()) { speakingId++; window.speechSynthesis.cancel(); } };

/** Read an answer aloud; click again to stop. */
export function SpeakButton({ text }: { text: string }) {
  const [on, setOn] = useState(false);
  useEffect(() => () => { if (on) stopSpeaking(); }, [on]);
  if (!canSpeak()) return null;
  return (
    <button type="button" className="link-btn speak-btn" aria-label={on ? 'Stop reading' : 'Read aloud'} onClick={() => { if (on) { stopSpeaking(); setOn(false); } else { setOn(true); speak(text, () => setOn(false)); } }}>
      {on ? <Square size={12} /> : <Volume2 size={13} />} {on ? 'Stop' : 'Read aloud'}
    </button>
  );
}

// ---- Voice commands (the microphone in the top bar) ----

export type VoiceTarget = 'home' | 'discover' | 'agents' | 'activity' | 'knowledge' | 'approvals' | 'insights' | 'dashboards' | 'impact' | 'settings' | 'memory' | 'trust';
export type VoiceIntent =
  | { kind: 'go'; tab: VoiceTarget; section?: 'orgs' | 'ai' | 'plan' | 'team' | 'approvals' | 'rules' }
  | { kind: 'new-agent'; request: string }
  | { kind: 'ask'; question: string }
  | { kind: 'theme'; dark: boolean }
  | { kind: 'tour' }
  | { kind: 'search'; text: string };

const PAGES: [RegExp, VoiceIntent][] = [
  [/\b(ai keys?|api keys?|spending|budget)\b/, { kind: 'go', tab: 'settings', section: 'ai' }],
  [/\b(team|people|users|invite)\b/, { kind: 'go', tab: 'settings', section: 'team' }],
  [/\brules?\b/, { kind: 'go', tab: 'settings', section: 'rules' }],
  [/\b(slack|teams)\b/, { kind: 'go', tab: 'settings', section: 'approvals' }],
  [/\b(plan|billing|subscription)\b/, { kind: 'go', tab: 'settings', section: 'plan' }],
  [/\b(salesforce orgs?|orgs?|connections?)\b/, { kind: 'go', tab: 'settings', section: 'orgs' }],
  [/\bapprovals?\b/, { kind: 'go', tab: 'approvals' }],
  [/\b(activity|runs?|history|logs?)\b/, { kind: 'go', tab: 'activity' }],
  [/\b(knowledge|guides?|documents?|docs)\b/, { kind: 'go', tab: 'knowledge' }],
  [/\binsights?\b/, { kind: 'go', tab: 'insights' }],
  [/\bdashboards?\b/, { kind: 'go', tab: 'dashboards' }],
  [/\b(impact|savings|roi)\b/, { kind: 'go', tab: 'impact' }],
  [/\bdiscover\b/, { kind: 'go', tab: 'discover' }],
  [/\bmemory\b/, { kind: 'go', tab: 'memory' }],
  [/\btrust( cent(er|re))?\b/, { kind: 'go', tab: 'trust' }],
  [/\bsettings\b/, { kind: 'go', tab: 'settings' }],
  [/\b(agents?|assistants?|automations?)\b/, { kind: 'go', tab: 'agents' }],
  [/\b(home|start|dashboard home)\b/, { kind: 'go', tab: 'home' }],
];

/** What a spoken sentence asks for. Pure; tested. */
export function parseVoiceCommand(said: string): VoiceIntent {
  const raw = said.trim().replace(/[.!?]+$/, '');
  const s = raw.toLowerCase().replace(/^(hey |ok |okay )?nimbus[, ]*/, '').replace(/^(please |can you |could you )+/, '').trim();
  const build = /^(create|build|make|set up|add)( me)? (a |an |new )*(agent|automation)\b[, ]*(that |to |which |for |who )?(.*)$/.exec(s);
  if (build) return { kind: 'new-agent', request: raw.slice(raw.length - build[6].length).trim() };
  if (/^(new agent|create an? agent|build an? agent)$/.test(s)) return { kind: 'new-agent', request: '' };
  if (/\b(dark mode|dark theme)\b/.test(s)) return { kind: 'theme', dark: true };
  if (/\b(light mode|light theme)\b/.test(s)) return { kind: 'theme', dark: false };
  if (/\b(tour|help me get started|show me around)\b/.test(s)) return { kind: 'tour' };
  const nav = /^(go( back)? to|open|show( me)?|take me to|switch to|navigate to|view|see)\b\s*(the |my |our )?(.*)$/.exec(s);
  const target = nav ? nav[5] : s;
  if (nav || target.split(/\s+/).length <= 3) {
    for (const [re, intent] of PAGES) if (re.test(target)) return intent;
  }
  // A question about the business ("how many…", "which accounts…"): Insights answers it from Salesforce data.
  if (/^(how (many|much)|which|what|who|when|where|show me|list|top|total|compare|why)\b/.test(s) || s.endsWith('?') || /\?$/.test(raw)) {
    return { kind: 'ask', question: raw };
  }
  return { kind: 'search', text: raw };
}

/** The top-bar microphone: listens once, then hands the sentence to the app. */
export function VoiceCommand({ onCommand }: { onCommand: (said: string) => void }) {
  const [live, setLive] = useState('');
  const { listening, start, stop, supported } = useListen((t) => { setLive(''); onCommand(t); }, setLive);
  useEffect(() => {
    if (!listening) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') stop(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [listening]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!supported) return null;
  return (
    <>
      <button className={'ghost icon' + (listening ? ' listening' : '')} onClick={start} aria-label={listening ? 'Stop listening' : 'Voice command'} title={listening ? 'Listening… (Esc to stop)' : 'Voice command: "open approvals", "create an agent that…", or ask a question'} aria-pressed={listening}>
        <Mic size={16} />
      </button>
      {listening && (
        <div className="voice-pill" role="status" aria-live="polite">
          <span className="voice-dot" />
          <span className="voice-text">{live || 'Listening… try "open approvals", "create an agent that…" or ask a question'}</span>
          <button className="ghost sm" onClick={stop}>Done</button>
        </div>
      )}
    </>
  );
}

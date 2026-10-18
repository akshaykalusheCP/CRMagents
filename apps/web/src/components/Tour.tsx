import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Guided tours: a spotlight on one thing at a time, with a short card. The tour moves between pages itself, waits for
// the page, scrolls the thing into view, and falls back to a centred card when it can't find it (e.g. on a phone).
// Remembers when someone finished or skipped, so it never nags; can be replayed.

export interface TourStep {
  /** Page to show first (App's tab) and, for settings, the section. */
  tab?: string; section?: string;
  /** What to light up: a CSS selector or a function; none = centred card. */
  target?: string | (() => Element | null | undefined);
  /** Something to do once the page is there (e.g. open a run), before looking for the target. */
  action?: () => void;
  /** Undo what `action` opened (e.g. close a drawer) when the tour moves on or closes. */
  leave?: () => void;
  title: string;
  body: string;
  /** An illustration instead of a spotlight (e.g. a Salesforce screen in the demo). */
  image?: { src: string; alt: string };
  /** Buttons on the last card. */
  ctas?: { label: string; primary?: boolean; run: () => void }[];
}
export interface TourDef { id: string; steps: TourStep[] }

const seenKey = (id: string) => `nimbus-tour:${id}`;
export const tourSeen = (id: string) => { try { return !!localStorage.getItem(seenKey(id)); } catch { return false; } };
const markSeen = (id: string, how: 'done' | 'skipped') => { try { localStorage.setItem(seenKey(id), how); } catch { /* private window */ } };
/** Start a tour from anywhere (e.g. the account menu). */
export const startTour = (id: string) => window.dispatchEvent(new CustomEvent('nimbus:tour', { detail: id }));

const shown = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
/** The first match that is actually on screen: every page stays mounted (hidden) in the app, so the first match in
 *  the document is often on another page. Hidden (e.g. a collapsed nav on a phone) counts as missing. */
export const visible = (sel: string) => [...document.querySelectorAll(sel)].find(shown) ?? null;
const find = (t: TourStep['target']) => {
  if (!t) return null;
  const el = typeof t === 'string' ? visible(t) : t();
  return el && shown(el) ? el : null;
};

export function Tour({ tours, go }: { tours: Record<string, TourDef>; go: (tab: string, section?: string) => void }) {
  const [id, setId] = useState<string | null>(null);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [ready, setReady] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const tour = id ? tours[id] : null;
  const step = tour?.steps[i];

  useEffect(() => {
    const on = (e: Event) => { const t = (e as CustomEvent).detail as string; if (tours[t]) { setI(0); setId(t); } };
    window.addEventListener('nimbus:tour', on);
    return () => window.removeEventListener('nimbus:tour', on);
  }, [tours]);

  // Leaving a step tidies up after it (e.g. closes the drawer it opened).
  const prev = useRef<TourStep | undefined>(undefined);
  useEffect(() => {
    if (prev.current && prev.current !== step) prev.current.leave?.();
    prev.current = step;
  }, [step]);

  // Go to the step's page, do its action, then wait (up to 4 s) for its target and bring it into view.
  useEffect(() => {
    if (!step) return;
    setReady(false); setRect(null);
    if (step.tab) go(step.tab, step.section);
    let alive = true, tries = 0, acted = false;
    const look = () => {
      if (!alive) return;
      if (step.action && !acted && tries >= 6) { acted = true; step.action(); }
      const el = find(step.target);
      if (el || !step.target || tries > 40) {
        if (el) { el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior }); setRect(el.getBoundingClientRect()); }
        setReady(true); return;
      }
      tries++; setTimeout(look, 100);
    };
    const t = setTimeout(look, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [id, i]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the spotlight on its target as the page moves.
  useEffect(() => {
    if (!step?.target || !ready) return;
    const upd = () => { const el = find(step.target); setRect(el ? el.getBoundingClientRect() : null); };
    window.addEventListener('resize', upd); window.addEventListener('scroll', upd, true);
    const iv = setInterval(upd, 500);
    return () => { window.removeEventListener('resize', upd); window.removeEventListener('scroll', upd, true); clearInterval(iv); };
  }, [step, ready]);

  const close = useCallback((how: 'done' | 'skipped') => { if (id) markSeen(id, how); setId(null); setI(0); }, [id]);
  const next = useCallback(() => { if (!tour) return; if (i < tour.steps.length - 1) setI(i + 1); else close('done'); }, [tour, i, close]);
  const back = useCallback(() => setI((x) => Math.max(0, x - 1)), []);

  useEffect(() => {
    if (!id) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close('skipped');
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [id, next, back, close]);

  // Card placement: beside the spotlight where there's room, else centred (always centred on small screens).
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const c = cardRef.current; if (!c) return;
    const vw = window.innerWidth, vh = window.innerHeight, cw = c.offsetWidth, ch = c.offsetHeight, gap = 16;
    if (!rect || vw < 700) { setPos(null); return; }
    const spaces = [
      { left: rect.left + rect.width / 2 - cw / 2, top: rect.bottom + gap, ok: vh - rect.bottom > ch + gap * 2 },
      { left: rect.left + rect.width / 2 - cw / 2, top: rect.top - ch - gap, ok: rect.top > ch + gap * 2 },
      { left: rect.right + gap, top: rect.top + rect.height / 2 - ch / 2, ok: vw - rect.right > cw + gap * 2 },
      { left: rect.left - cw - gap, top: rect.top + rect.height / 2 - ch / 2, ok: rect.left > cw + gap * 2 },
    ];
    const s = spaces.find((x) => x.ok);
    if (!s) { setPos({ left: vw - cw - 24, top: vh - ch - 24 }); return; } // big target: card in the corner
    setPos({ left: Math.max(12, Math.min(vw - cw - 12, s.left)), top: Math.max(12, Math.min(vh - ch - 12, s.top)) });
  }, [rect, i, ready]);

  if (!tour || !step) return null;
  const pad = 8;
  const hole = rect && { left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
  const last = i === tour.steps.length - 1;
  return createPortal(
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {hole ? <div className="tour-hole" style={hole} /> : <div className="tour-dim" />}
      <div ref={cardRef} className={'tour-card' + (pos ? '' : ' centred') + (step.image ? ' wide' : '')} style={pos ?? undefined} data-ready={ready}>
        <div className="tour-top">
          <span className="tour-step">{i + 1} of {tour.steps.length}</span>
          <button className="tour-x" aria-label="Close the tour" onClick={() => close('skipped')}><X size={16} /></button>
        </div>
        {step.image && <img className="tour-img" src={step.image.src} alt={step.image.alt} />}
        <h3 id="tour-title">{step.title}</h3>
        <p>{step.body}</p>
        <div className="tour-dots" aria-hidden>{tour.steps.map((_, k) => <i key={k} className={k === i ? 'on' : k < i ? 'done' : ''} />)}</div>
        <div className="tour-actions">
          {i > 0 ? <button className="ghost sm" onClick={back}><ArrowLeft size={14} /> Back</button> : <button className="ghost sm" onClick={() => close('skipped')}>Skip tour</button>}
          <span style={{ flex: 1 }} />
          {last && step.ctas
            ? step.ctas.map((c) => <button key={c.label} className={c.primary ? 'primary sm' : 'sm'} onClick={() => { close('done'); c.run(); }}>{c.label}</button>)
            : <button className="primary sm" onClick={next} autoFocus>{last ? 'Done' : 'Next'} {!last && <ArrowRight size={14} />}</button>}
        </div>
      </div>
    </div>,
    document.querySelector('.app') ?? document.body,
  );
}

// ---------- The tours ----------
const navButton = (label: string) => () => [...document.querySelectorAll('.tnav-links button, .tnav-links a, .side-nav button')].find((b) => b.textContent?.trim().startsWith(label));

/** For visitors: the demo workspace, start to finish (about 2 minutes). */
export const visitorTour = (signUp: () => void): TourDef => ({
  id: 'visitor',
  steps: [
    { tab: 'home', title: 'Welcome to Nimbus', body: 'AI agents for Salesforce. This is a demo workspace with sample data: click around freely, nothing here touches a real org. Two minutes, ten stops.' },
    { tab: 'home', target: '.home2-top', title: 'Your day at a glance', body: 'What agents did, what\'s waiting for a person, and what the AI cost today, against the daily budget you set.' },
    { tab: 'home', target: '[aria-label="Suggested agents"]', title: 'Agents it suggests', body: 'Nimbus looks at your Salesforce data (counts only, no AI) and suggests agents worth building: stale deals, cold leads, cases left open.' },
    { tab: 'discover', target: '.dc-hero', title: 'The hand work in your org', body: 'Discover finds what your team does by hand that an agent could do, and how many hours a month it costs. Then it builds the agent and proves it on your own records.' },
    { tab: 'agents', target: '.tbl-wrap', title: 'Agents, in plain English', body: 'Describe a job in a sentence and the builder turns it into steps you can read. They use your own Flows and Apex.' },
    { tab: 'approvals', target: '.inbox-detail', title: 'Nothing changes until you say so', body: 'Agents stop here before changing Salesforce. Approve or reject in Nimbus, in the Salesforce bell, or right in Slack.' },
    { tab: 'activity', action: () => (visible('.tbl tbody tr') as HTMLElement | null)?.click(), leave: () => (document.querySelector('.sheet-back') as HTMLElement | null)?.click(), target: '.chg', title: 'Every change, with one-click undo', body: 'Each change is logged with its old value. Undo a whole run in one click; anything a person edited since is never overwritten.' },
    { image: { src: '/tour/salesforce-panel.png', alt: 'The Nimbus panel and Suggestions card on a Salesforce Case page' }, title: 'It lives inside Salesforce', body: 'On every record: agents to run, an assistant to ask, approvals, and what agents changed, with Undo. Plus an "Ask Nimbus" button and Flow actions. It sees only what each person can see.' },
    { tab: 'trust', target: '.tour-safeguards', title: 'Your data stays yours', body: 'Personal data is masked before the AI sees it, every AI call is logged exactly as sent, and you choose the AI (Claude, OpenAI or Gemini) with a daily cap.' },
    { tab: 'insights', target: '.briefing', title: 'Your business, in plain English', body: 'A briefing on your Salesforce numbers, dashboards from one sentence, and answers to questions about your data.' },
    { title: 'That\'s Nimbus', body: 'Priced for the whole team, not per seat. Connect your Salesforce org in about two minutes and try it on your own records: 14 days free.',
      ctas: [{ label: 'Keep exploring', run: () => {} }, { label: 'Start free', primary: true, run: signUp }] },
  ],
});

/** For a new workspace on first sign-in: where things are, then on to the setup steps. */
export const welcomeTour = (name: string, connect: () => void): TourDef => ({
  id: 'welcome',
  steps: [
    { tab: 'home', title: `Welcome to Nimbus${name ? `, ${name}` : ''}`, body: 'A one-minute look around, then you\'ll connect Salesforce and get your first agent working.' },
    { tab: 'home', target: '.fr', title: 'Your first agent, step by step', body: 'Follow these steps: connect Salesforce, pick a starter agent, try it on a record, turn it on. About 10 minutes.' },
    { tab: 'home', target: navButton('Agents'), title: 'Agents', body: 'Build agents by describing the job, or start from a proven use case. Assistants answer questions in Salesforce and here.' },
    { tab: 'home', target: navButton('Approvals'), title: 'Approvals', body: 'Anything an agent wants to change in Salesforce waits here (and in the Salesforce bell) until someone approves.' },
    { tab: 'home', target: 'button.acct', title: 'Trust center, team and settings', body: 'Your account menu has the Trust center (what the AI saw), your team, Slack and Teams, and settings.' },
    { title: 'Ready?', body: 'Connect your Salesforce org: you log in on Salesforce\'s own page and Nimbus sets itself up.',
      ctas: [{ label: 'Later', run: () => {} }, { label: 'Connect Salesforce', primary: true, run: connect }] },
  ],
});

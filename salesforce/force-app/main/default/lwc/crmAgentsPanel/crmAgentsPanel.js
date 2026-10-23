import { LightningElement, api } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import namespace from '@salesforce/apex/CRMAgentsController.namespace';
import { subscribe, unsubscribe, onError } from 'lightning/empApi';
import home from '@salesforce/apex/CRMAgentsController.home';
import startRun from '@salesforce/apex/CRMAgentsController.startRun';
import getRun from '@salesforce/apex/CRMAgentsController.getRun';
import decideWithNote from '@salesforce/apex/CRMAgentsController.decideWithNote';
import startChat from '@salesforce/apex/CRMAgentsController.startChat';
import chatContext from '@salesforce/apex/CRMAgentsController.chatContext';
import askResult from '@salesforce/apex/CRMAgentsController.askResult';
import execTools from '@salesforce/apex/CRMAgentsController.execTools';
import postToolResults from '@salesforce/apex/CRMAgentsController.postToolResults';
import { markdownToHtml } from 'c/crmMarkdown';

// The event channel and payload fields carry the package namespace when there is one (e.g. nimbus__Run_Id__c).
const channelFor = (ns) => '/event/' + (ns ? ns + '__' : '') + 'CRMagents_Run_Event__e';
// Images: shrunk here (longest side 1024 px) so the upload stays small for Apex; sent to the AI as they are.
const MAX_IMAGES = 3;
const MAX_SIDE = 1024;
const MAX_TOTAL_B64 = 1600000;
const OK_IMAGE = /^image\/(jpeg|png|gif|webp)$/;
let imageSeq = 0;
function shrinkImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(file.name + ' could not be read.'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error(file.name + ' could not be opened.'));
            img.onload = () => {
                const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(img.naturalWidth * scale);
                canvas.height = Math.round(img.naturalHeight * scale);
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                const type = file.type === 'image/png' && file.size < 600000 ? 'image/png' : 'image/jpeg';
                const url = canvas.toDataURL(type, 0.82);
                imageSeq += 1;
                resolve({ key: 'img' + imageSeq, name: file.name || 'image', mediaType: type, data: url.substring(url.indexOf(',') + 1), preview: url });
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}
// Voice: the browser's own speech recognition (Chrome, Edge, Safari) and speech synthesis.
const speechCtor = () => (typeof window === 'undefined' ? undefined : window.SpeechRecognition || window.webkitSpeechRecognition);
const speakable = (md) => String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const field = (p, k) => (p ? (p[k] !== undefined ? p[k] : p[Object.keys(p).find((x) => x.endsWith('__' + k))]) : undefined);
const POLL_MS = 3000;
const STATUS = { running: 'Running…', waiting: 'Waiting for approval', sleeping: 'Waiting on a timer', done: 'Done', error: 'Failed', stopped: 'Stopped', cancelled: 'Cancelled' };
const TONE = { done: 'slds-theme_success', error: 'slds-theme_error', waiting: 'slds-theme_warning', stopped: 'slds-theme_warning' };

export default class CrmAgentsPanel extends LightningElement {
    @api recordId;
    @api objectApiName;
    /** Smaller layout for the quick action popup and the utility bar. */
    @api compact = false;

    data;
    error;
    loading = true;
    // Agents tab
    instructions = '';
    showInstructions = false;
    run; // the run started from this panel
    runAgent;
    timer;
    // Ask tab
    assistantId;
    question = '';
    thread = [];
    asking = false;
    images = []; // { key, name, mediaType, data, preview }
    listening = false;
    readAloud = false;
    speakingKey;
    // Approvals
    notes = {};
    deciding;
    subscription;

    connectedCallback() {
        try { this.readAloud = window.localStorage.getItem('nimbus-read-aloud') === '1'; } catch (e) { /* storage blocked */ }
        this.load();
        // Utility bar panels stay open in the background: refresh when the panel becomes visible again.
        this.onVisible = () => { if (document.visibilityState === 'visible') this.load(); };
        document.addEventListener('visibilitychange', this.onVisible);
        // Live updates: Nimbus publishes an event whenever a run changes state.
        namespace().then((ns) => subscribe(channelFor(ns), -1, (msg) => this.onEvent(msg && msg.data && msg.data.payload)))
            .then((s) => { this.subscription = s; })
            .catch(() => { /* polling covers it */ });
        onError(() => { /* polling covers it */ });
    }

    disconnectedCallback() {
        if (this.recognition) this.recognition.abort();
        this.stopSpeaking();
        clearTimeout(this.timer);
        clearTimeout(this.askTimer);
        document.removeEventListener('visibilitychange', this.onVisible);
        if (this.subscription) unsubscribe(this.subscription, () => {});
    }

    load() {
        this.loading = true;
        return home({ recordId: this.recordId, objectApiName: this.objectApiName })
            .then((json) => {
                this.data = JSON.parse(json);
                this.error = undefined;
                if (!this.assistantId && this.data.assistants.length) { this.assistantId = this.data.assistants[0].id; this.loadChat(); }
            })
            .catch((e) => { this.error = this.message(e); })
            .finally(() => { this.loading = false; });
    }

    onEvent(p) {
        if (!p) return;
        if (this.run && field(p, 'Run_Id__c') === this.run.runId) this.refreshRun();
        const rid = field(p, 'Record_Id__c');
        if (!rid || rid === this.recordId || field(p, 'Status__c') === 'waiting') this.load();
    }

    // ---------- getters ----------
    get ready() { return !!this.data; }
    get agents() {
        const busy = this.runBusy;
        return ((this.data && this.data.agents) || []).map((a) => ({
            ...a,
            liveLabel: a.live ? 'On' : 'Off',
            hint: a.needsRecord ? `Open a ${a.needsRecord} to run it` : a.trigger,
            cannotRun: busy || !!a.needsRecord
        }));
    }
    get hasAgents() { return this.agents.length > 0; }
    get emptyText() {
        return this.data && this.data.totalAgents
            ? `None of your agents run on ${this.objectApiName || 'this page'}. Agents for other records show up when you open them.`
            : 'No agents yet. Build one in Nimbus and it shows up here.';
    }
    get assistants() { return ((this.data && this.data.assistants) || []).map((a) => ({ label: a.name, value: a.id })); }
    get hasAssistants() { return this.assistants.length > 0; }
    get approvals() {
        return ((this.data && this.data.approvals) || []).map((a) => ({
            ...a,
            lines: String(a.message || '').split('\n').filter((l) => l.trim()).map((l, i) => ({ key: a.runId + i, text: l.replace(/^-\s*/, '') })),
            note: this.notes[a.runId] || '',
            busy: this.deciding === a.runId,
            when: new Date(a.createdAt).toLocaleString()
        }));
    }
    get approvalCount() { return this.approvals.length; }
    get approvalsLabel() { return this.approvalCount ? `Approvals (${this.approvalCount})` : 'Approvals'; }
    get hasApprovals() { return this.approvalCount > 0; }
    get recent() {
        return ((this.data && this.data.recent) || []).map((r) => ({ ...r, label: STATUS[r.status] || r.status, when: new Date(r.createdAt).toLocaleString() }));
    }
    get hasRecent() { return this.recent.length > 0 && !this.compact; }
    get runOutputHtml() { return this.run && this.run.output ? markdownToHtml(this.run.output) : ''; }
    get runLabel() { return this.run ? STATUS[this.run.status] || this.run.status : ''; }
    get runTone() { return 'slds-badge ' + ((this.run && TONE[this.run.status]) || ''); }
    get runWaiting() { return this.run && this.run.status === 'waiting'; }
    get runBusy() { return this.run && (this.run.status === 'running'); }
    get runSteps() {
        return ((this.run && this.run.steps) || []).map((s, i) => ({ key: i + s.label, label: s.label, icon: s.status === 'ok' ? 'utility:success' : s.status === 'error' ? 'utility:error' : 'utility:clock' }));
    }
    get messages() {
        return this.thread.map((m, i) => ({
            key: i, text: m.text, mine: m.role === 'user', html: m.role === 'user' ? '' : markdownToHtml(m.text), css: m.role === 'user' ? 'bubble me' : 'bubble ai md',
            pics: (m.pics || []).map((src, j) => ({ key: i + '-p' + j, src })),
            canRead: m.role !== 'user' && this.canSpeak && !String(m.text).startsWith('Sorry:'),
            readLabel: this.speakingKey === i ? 'Stop reading' : 'Read aloud',
            readIcon: this.speakingKey === i ? 'utility:stop' : 'utility:volume_high',
            readKey: 'read-' + i,
            memory: (m.remembered || []).map((r, j) => ({ key: i + '-' + j, text: (r.kind === 'record' ? 'Noted on this record: ' : 'Saved to memory: ') + r.text }))
        }));
    }
    get cannotAsk() { return this.asking || (!this.question.trim() && !this.images.length) || !this.assistantId; }
    get hasImages() { return this.images.length > 0; }
    get cannotAttach() { return this.images.length >= MAX_IMAGES; }
    get canListen() { return !!speechCtor(); }
    get canSpeak() { return typeof window !== 'undefined' && !!window.speechSynthesis; }
    get micIcon() { return this.listening ? 'utility:muted' : 'utility:unmuted'; }
    get micLabel() { return this.listening ? 'Stop listening' : 'Ask by voice'; }
    get micVariant() { return this.listening ? 'brand' : 'border-filled'; }
    get questionPlaceholder() { return this.images.length ? 'Ask about the image…' : "Ask about this record, e.g. What's the history with this customer? (you can paste a screenshot)"; }
    get notConnected() { return this.error && /not connected|CRMagents_Config/i.test(this.error); }

    // ---------- agents ----------
    toggleInstructions() { this.showInstructions = !this.showInstructions; }
    handleInstructions(e) { this.instructions = e.detail.value; }
    handleRun(e) {
        const id = e.currentTarget.dataset.id;
        this.runAgent = (this.agents.find((a) => a.id === id) || {}).name;
        this.error = undefined;
        this.run = { status: 'running', steps: [] };
        startRun({ workflowId: id, recordId: this.recordId, objectApiName: this.objectApiName, input: this.instructions })
            .then((r) => this.acceptRun(r))
            .catch((err) => { this.run = undefined; this.error = this.message(err); });
    }
    acceptRun(r) {
        this.run = r;
        clearTimeout(this.timer);
        if (r.status === 'running') this.timer = setTimeout(() => this.refreshRun(), POLL_MS);
        else this.load();
    }
    refreshRun() {
        if (!this.run || !this.run.runId) return;
        getRun({ runId: this.run.runId }).then((r) => this.acceptRun(r)).catch(() => {});
    }
    closeRun() { this.run = undefined; }
    approveRun() { this.decide(this.run.runId, true); }
    rejectRun() { this.decide(this.run.runId, false); }

    // ---------- approvals ----------
    handleNote(e) { this.notes = { ...this.notes, [e.currentTarget.dataset.id]: e.detail.value }; }
    handleApprove(e) { this.decide(e.currentTarget.dataset.id, true); }
    handleReject(e) { this.decide(e.currentTarget.dataset.id, false); }
    decide(runId, approve) {
        this.deciding = runId;
        decideWithNote({ runId, approve, note: this.notes[runId] || '' })
            .then((r) => { if (this.run && this.run.runId === runId) this.acceptRun(r); return this.load(); })
            .catch((e) => { this.error = this.message(e); })
            .finally(() => { this.deciding = undefined; });
    }

    // ---------- ask ----------
    handleAssistant(e) { this.assistantId = e.detail.value; this.thread = []; this.conversationId = null; this.loadChat(); }

    // Memory: pick up this person's last chat on this record, and show what agents noted about it.
    conversationId = null;
    resumed = false;
    notes = [];
    loadChat() {
        if (!this.assistantId) return;
        chatContext({ recordId: this.recordId, assistantId: this.assistantId })
            .then((json) => {
                const c = JSON.parse(json);
                this.notes = (c.notes || []).map((n) => ({ key: n.id, text: n.note, by: n.author || 'Agent' }));
                const last = c.latest;
                // Recent and not already in progress here: continue it.
                if (last && !this.thread.length && Date.now() - new Date(last.updatedAt).getTime() < 7 * 86400000) {
                    this.thread = last.messages.map((m) => ({ role: m.role, text: m.text }));
                    this.conversationId = last.id;
                    this.resumed = true;
                }
            })
            .catch(() => {});
    }
    get hasNotes() { return this.notes.length > 0; }
    handleQuestion(e) { this.question = e.detail.value; }
    handleQuestionKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); } }
    send() {
        const q = this.question.trim() || (this.images.length ? 'What does this show?' : '');
        if (!q || this.asking) return;
        const history = this.thread.slice(-20);
        const pics = this.images;
        this.thread = [...this.thread, { role: 'user', text: q, pics: pics.map((p) => p.preview) }];
        this.question = '';
        this.images = [];
        this.asking = true;
        const imagesJson = pics.length ? JSON.stringify(pics.map((p) => ({ mediaType: p.mediaType, data: p.data, name: p.name }))) : null;
        // Start the question, then check for the answer: nothing in Salesforce waits on the AI.
        startChat({ assistantId: this.assistantId, question: q, recordId: this.recordId, objectApiName: this.objectApiName, historyJson: JSON.stringify(history.map((m) => ({ role: m.role, text: m.text }))), conversationId: this.conversationId, imagesJson })
            .then((json) => { const s = JSON.parse(json); if (s.conversationId) this.conversationId = s.conversationId; return this.waitForAnswer(s.runId, 0); })
            .then((r) => {
                this.thread = [...this.thread, { role: 'assistant', text: r.answer, remembered: r.remembered || [] }];
                if (this.readAloud) this.speak(this.thread.length - 1);
            })
            .catch((e) => { this.thread = [...this.thread, { role: 'assistant', text: 'Sorry: ' + this.message(e) }]; })
            .finally(() => { this.asking = false; });
    }
    waitForAnswer(runId, tries) {
        if (tries > 150) return Promise.reject(new Error('The answer is taking too long. Try again in a moment.'));
        // Quick checks at first (most answers take a few seconds), then every 3 seconds.
        const delay = tries < 10 ? 1200 : 3000;
        return new Promise((resolve) => { this.askTimer = setTimeout(resolve, delay); })
            .then(() => askResult({ runId }))
            .then((json) => {
                const r = JSON.parse(json);
                if (r.status === 'done') return r;
                if (r.status === 'error') throw new Error(r.error || 'The assistant could not answer');
                if (r.status === 'tool') {
                    // The assistant needs Salesforce data or a change: run it here, as this user, then hand it back.
                    return execTools({ callsJson: JSON.stringify(r.calls) })
                        .then((results) => postToolResults({ runId, resultsJson: results }))
                        .then(() => this.waitForAnswer(runId, 0));
                }
                return this.waitForAnswer(runId, tries + 1);
            });
    }

    newConversation() { this.thread = []; this.conversationId = null; this.resumed = false; this.images = []; }

    // ---------- images (attach, paste) ----------
    pickImages() { const input = this.template.querySelector('input.img-input'); if (input) input.click(); }
    handleFiles(e) { const files = e.target.files; this.addFiles(files); e.target.value = ''; }
    handlePaste(e) {
        const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter((f) => f.type.indexOf('image/') === 0);
        if (files.length) { e.preventDefault(); this.addFiles(files); }
    }
    addFiles(files) {
        const list = Array.from(files || []).filter((f) => OK_IMAGE.test(f.type));
        if (!list.length) { this.toastError('Attach a JPG, PNG, GIF or WebP image.'); return; }
        const room = MAX_IMAGES - this.images.length;
        list.slice(0, room).reduce((p, f) => p.then(() => shrinkImage(f).then((img) => {
            const total = this.images.reduce((n, x) => n + x.data.length, 0) + img.data.length;
            if (total > MAX_TOTAL_B64) { this.toastError('Those images are too large together. Try fewer or smaller images.'); return; }
            this.images = [...this.images, img];
        })), Promise.resolve()).catch((err) => this.toastError(err.message || 'That image could not be read.'));
        if (list.length > room) this.toastError('Up to ' + MAX_IMAGES + ' images per question.');
    }
    removeImage(e) { const key = e.currentTarget.dataset.key; this.images = this.images.filter((x) => x.key !== key); }
    toastError(message) { this.dispatchEvent(new ShowToastEvent({ title: message, variant: 'warning' })); }

    // ---------- voice ----------
    toggleListen() {
        const C = speechCtor();
        if (!C) return;
        if (this.recognition) { this.recognition.stop(); return; }
        const r = new C();
        r.lang = navigator.language || 'en-US';
        r.interimResults = true;
        r.continuous = false;
        const before = this.question.trim();
        let finalText = '';
        r.onresult = (e) => {
            let live = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const t = e.results[i][0].transcript;
                if (e.results[i].isFinal) finalText += t; else live += t;
            }
            this.question = (before ? before + ' ' : '') + (finalText + live).trim();
        };
        r.onerror = (e) => {
            if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.toastError('The microphone is blocked. Allow it for Salesforce in your browser. If it stays blocked, an admin can allow it in Setup → Session Settings → Browser Feature Permissions → Microphone.');
            else if (e.error === 'audio-capture') this.toastError('No microphone was found.');
            else if (e.error !== 'no-speech' && e.error !== 'aborted') this.toastError('Voice input stopped (' + e.error + ').');
        };
        r.onend = () => {
            this.recognition = null;
            this.listening = false;
            if (finalText.trim()) this.send();
        };
        this.recognition = r;
        this.listening = true;
        try { r.start(); } catch (err) { this.recognition = null; this.listening = false; }
    }
    handleReadAloud(e) {
        this.readAloud = e.detail && e.detail.checked !== undefined ? e.detail.checked : e.target.checked;
        try { window.localStorage.setItem('nimbus-read-aloud', this.readAloud ? '1' : '0'); } catch (err) { /* storage blocked */ }
    }
    readMessage(e) {
        const i = Number(e.currentTarget.dataset.index);
        if (this.speakingKey === i) { this.stopSpeaking(); return; }
        this.speak(i);
    }
    speak(i) {
        if (!this.canSpeak) return;
        const m = this.thread[i];
        if (!m) return;
        window.speechSynthesis.cancel();
        const u = new window.SpeechSynthesisUtterance(speakable(m.text).slice(0, 4000));
        u.lang = navigator.language || 'en-US';
        u.onend = () => { if (this.speakingKey === i) this.speakingKey = undefined; };
        this.speakingKey = i;
        window.speechSynthesis.speak(u);
    }
    stopSpeaking() { if (this.canSpeak) window.speechSynthesis.cancel(); this.speakingKey = undefined; }

    refresh() { this.load(); }
    message(e) { return (e && e.body && e.body.message) || (e && e.message) || 'Something went wrong'; }
}

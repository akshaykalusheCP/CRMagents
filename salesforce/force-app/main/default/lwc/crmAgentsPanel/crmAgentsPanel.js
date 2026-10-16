import { LightningElement, api } from 'lwc';
import { subscribe, unsubscribe, onError } from 'lightning/empApi';
import home from '@salesforce/apex/CRMAgentsController.home';
import startRun from '@salesforce/apex/CRMAgentsController.startRun';
import getRun from '@salesforce/apex/CRMAgentsController.getRun';
import decideWithNote from '@salesforce/apex/CRMAgentsController.decideWithNote';
import ask from '@salesforce/apex/CRMAgentsController.ask';

const CHANNEL = '/event/CRMagents_Run_Event__e';
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
    // Approvals
    notes = {};
    deciding;
    subscription;

    connectedCallback() {
        this.load();
        // Live updates: CRMagents publishes an event whenever a run changes state.
        subscribe(CHANNEL, -1, (msg) => this.onEvent(msg && msg.data && msg.data.payload))
            .then((s) => { this.subscription = s; })
            .catch(() => { /* polling covers it */ });
        onError(() => { /* polling covers it */ });
    }

    disconnectedCallback() {
        clearTimeout(this.timer);
        if (this.subscription) unsubscribe(this.subscription, () => {});
    }

    load() {
        this.loading = true;
        return home({ recordId: this.recordId, objectApiName: this.objectApiName })
            .then((json) => {
                this.data = JSON.parse(json);
                this.error = undefined;
                if (!this.assistantId && this.data.assistants.length) this.assistantId = this.data.assistants[0].id;
            })
            .catch((e) => { this.error = this.message(e); })
            .finally(() => { this.loading = false; });
    }

    onEvent(p) {
        if (!p) return;
        if (this.run && p.Run_Id__c === this.run.runId) this.refreshRun();
        if (!p.Record_Id__c || p.Record_Id__c === this.recordId || p.Status__c === 'waiting') this.load();
    }

    // ---------- getters ----------
    get ready() { return !!this.data; }
    get agents() {
        return ((this.data && this.data.agents) || []).map((a) => ({ ...a, liveLabel: a.live ? 'On' : 'Off' }));
    }
    get hasAgents() { return this.agents.length > 0; }
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
    get runLabel() { return this.run ? STATUS[this.run.status] || this.run.status : ''; }
    get runTone() { return 'slds-badge ' + ((this.run && TONE[this.run.status]) || ''); }
    get runWaiting() { return this.run && this.run.status === 'waiting'; }
    get runBusy() { return this.run && (this.run.status === 'running'); }
    get runSteps() {
        return ((this.run && this.run.steps) || []).map((s, i) => ({ key: i + s.label, label: s.label, icon: s.status === 'ok' ? 'utility:success' : s.status === 'error' ? 'utility:error' : 'utility:clock' }));
    }
    get messages() {
        return this.thread.map((m, i) => ({ key: i, text: m.text, css: m.role === 'user' ? 'bubble me' : 'bubble ai' }));
    }
    get cannotAsk() { return this.asking || !this.question.trim() || !this.assistantId; }
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
    handleAssistant(e) { this.assistantId = e.detail.value; this.thread = []; }
    handleQuestion(e) { this.question = e.detail.value; }
    handleQuestionKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); } }
    send() {
        const q = this.question.trim();
        if (!q || this.asking) return;
        const history = this.thread.slice(-20);
        this.thread = [...this.thread, { role: 'user', text: q }];
        this.question = '';
        this.asking = true;
        ask({ assistantId: this.assistantId, question: q, recordId: this.recordId, objectApiName: this.objectApiName, historyJson: JSON.stringify(history) })
            .then((json) => { this.thread = [...this.thread, { role: 'assistant', text: JSON.parse(json).answer }]; })
            .catch((e) => { this.thread = [...this.thread, { role: 'assistant', text: 'Sorry: ' + this.message(e) }]; })
            .finally(() => { this.asking = false; });
    }
    newConversation() { this.thread = []; }

    refresh() { this.load(); }
    message(e) { return (e && e.body && e.body.message) || (e && e.message) || 'Something went wrong'; }
}

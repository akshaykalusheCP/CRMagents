import { LightningElement, api } from 'lwc';
import listWorkflows from '@salesforce/apex/CRMAgentsController.listWorkflows';
import startRun from '@salesforce/apex/CRMAgentsController.startRun';
import getRun from '@salesforce/apex/CRMAgentsController.getRun';
import decide from '@salesforce/apex/CRMAgentsController.decide';

const POLL_MS = 2000;
const ICONS = { ok: '✓', error: '✗', waiting: '⏸' };

export default class CrmAgentsPanel extends LightningElement {
    @api recordId;
    @api objectApiName;

    workflows = [];
    loadedWorkflows = false;
    selected;
    input = '';
    run;
    error;
    loading = false;
    timer;

    connectedCallback() {
        this.loading = true;
        listWorkflows({ objectApiName: this.objectApiName })
            .then((list) => {
                this.workflows = list;
                this.selected = list.length ? list[0].id : undefined;
            })
            .catch((e) => {
                this.error = this.message(e);
            })
            .finally(() => {
                this.loadedWorkflows = true;
                this.loading = false;
            });
    }

    disconnectedCallback() {
        clearTimeout(this.timer);
    }

    get options() {
        return this.workflows.map((w) => ({ label: w.name, value: w.id }));
    }
    get hasWorkflows() {
        return this.workflows.length > 0;
    }
    get noWorkflows() {
        return this.loadedWorkflows && !this.error && this.workflows.length === 0;
    }
    get isWaiting() {
        return this.run && this.run.status === 'waiting';
    }
    get isRunning() {
        return this.run && this.run.status === 'running';
    }
    get isBusy() {
        return this.loading || this.isRunning || this.isWaiting;
    }
    get cannotRun() {
        return this.isBusy || !this.selected;
    }
    get statusLabel() {
        const map = { running: 'Running…', waiting: 'Waiting for approval', done: 'Done', error: 'Failed' };
        return map[this.run.status] || this.run.status;
    }
    get steps() {
        return ((this.run && this.run.steps) || []).map((s, i) => ({
            key: i + s.label,
            label: s.label,
            icon: ICONS[s.status] || '•'
        }));
    }

    handleSelect(event) {
        this.selected = event.detail.value;
    }
    handleInput(event) {
        this.input = event.detail.value;
    }

    handleRun() {
        this.error = undefined;
        this.run = undefined;
        this.loading = true;
        startRun({
            workflowId: this.selected,
            recordId: this.recordId,
            objectApiName: this.objectApiName,
            input: this.input
        })
            .then((r) => this.accept(r))
            .catch((e) => {
                this.error = this.message(e);
            })
            .finally(() => {
                this.loading = false;
            });
    }

    handleApprove() {
        this.decision(true);
    }
    handleReject() {
        this.decision(false);
    }

    decision(approve) {
        this.loading = true;
        decide({ runId: this.run.runId, approve })
            .then((r) => this.accept(r))
            .catch((e) => {
                this.error = this.message(e);
            })
            .finally(() => {
                this.loading = false;
            });
    }

    accept(r) {
        this.run = r;
        if (r.status === 'running') {
            this.timer = setTimeout(() => this.poll(), POLL_MS);
        }
    }

    poll() {
        getRun({ runId: this.run.runId })
            .then((r) => this.accept(r))
            .catch((e) => {
                this.error = this.message(e);
            });
    }

    message(e) {
        return (e && e.body && e.body.message) || (e && e.message) || 'Something went wrong';
    }
}

import { LightningElement, api } from 'lwc';
import { subscribe, unsubscribe, onError } from 'lightning/empApi';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import suggestions from '@salesforce/apex/CRMAgentsController.suggestions';
import rateSuggestion from '@salesforce/apex/CRMAgentsController.rateSuggestion';
import { markdownToHtml } from 'c/crmMarkdown';

const CHANNEL = '/event/CRMagents_Run_Event__e';

function ago(iso) {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 1440) return Math.round(m / 60) + ' h ago';
    return new Date(iso).toLocaleDateString();
}

/** Suggestions agents saved on this record. Read-only advice: people copy what they need and rate it. */
export default class CrmSuggestions extends LightningElement {
    @api recordId;
    items = [];
    error;
    loading = true;
    showOlder = false;
    subscription;

    connectedCallback() {
        this.load();
        // An agent that finishes for this record usually just saved a suggestion.
        subscribe(CHANNEL, -1, (msg) => {
            const p = msg && msg.data && msg.data.payload;
            if (p && p.Record_Id__c && this.recordId && p.Record_Id__c.substring(0, 15) === this.recordId.substring(0, 15) && p.Status__c === 'done') this.load();
        }).then((s) => { this.subscription = s; }).catch(() => {});
        onError(() => {});
    }

    disconnectedCallback() {
        if (this.subscription) unsubscribe(this.subscription, () => {});
    }

    load() {
        if (!this.recordId) return;
        suggestions({ recordId: this.recordId })
            .then((json) => {
                this.items = JSON.parse(json).map((s) => ({
                    ...s,
                    html: markdownToHtml(s.body || ''),
                    when: ago(s.createdAt),
                    by: s.agentName ? s.agentName + ' · ' + ago(s.createdAt) : ago(s.createdAt),
                    sourceText: (s.sources || []).map((x) => x.title + (x.section ? ' (' + x.section + ')' : '')).join('; '),
                    helpful: s.status === 'helpful',
                    notHelpful: s.status === 'not_helpful'
                }));
                this.error = undefined;
            })
            .catch((e) => { this.error = (e && e.body && e.body.message) || 'Could not load suggestions'; })
            .finally(() => { this.loading = false; });
    }

    get latest() { return this.items[0]; }
    get older() { return this.items.slice(1); }
    get hasOlder() { return this.items.length > 1; }
    get olderLabel() { return (this.showOlder ? 'Hide' : 'Show') + ' ' + this.older.length + ' earlier'; }
    get empty() { return !this.loading && !this.error && this.items.length === 0; }
    get helpfulVariant() { return this.latest && this.latest.helpful ? 'brand' : 'border-filled'; }
    get notHelpfulVariant() { return this.latest && this.latest.notHelpful ? 'brand' : 'border-filled'; }

    toggleOlder() { this.showOlder = !this.showOlder; }

    rate(status) {
        const s = this.latest;
        if (!s) return Promise.resolve();
        return rateSuggestion({ suggestionId: s.id, status })
            .then(() => {
                if (status === 'dismissed') {
                    this.items = this.items.slice(1);
                } else {
                    this.items = [{ ...s, status, helpful: status === 'helpful', notHelpful: status === 'not_helpful' }, ...this.items.slice(1)];
                    this.toast(status === 'helpful' ? 'Thanks: marked helpful' : 'Thanks: marked not helpful', 'success');
                }
            })
            .catch((e) => this.toast((e && e.body && e.body.message) || 'Could not save', 'error'));
    }
    helpful() { this.rate('helpful'); }
    notHelpful() { this.rate('not_helpful'); }
    dismiss() { this.rate('dismissed'); }

    copy() {
        const s = this.latest;
        if (!s) return;
        const text = (s.body || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#+\s*/gm, '');
        const done = () => this.toast('Copied', 'success');
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(() => this.copyFallback(text, done));
        } else {
            this.copyFallback(text, done);
        }
    }

    copyFallback(text, done) {
        const ta = document.createElement('textarea');
        ta.value = text;
        this.template.querySelector('.copy-host').appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { this.toast('Select the text and copy it', 'warning'); }
        ta.remove();
    }

    toast(title, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, variant }));
    }
}

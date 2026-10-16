import { LightningElement, api } from 'lwc';

// "Ask CRMagents" button on records: the Agent Panel in a popup.
export default class CrmAgentsAction extends LightningElement {
    @api recordId;
    @api objectApiName;
}

/**
 * Used by the Flows Nimbus adds for agents: on save, publish a Nimbus Record Change event (no callout, so it works
 * in the immediate part of a record-triggered Flow and in bulk). Nimbus listens for the events and starts the agent.
 */
global with sharing class CRMPublishChange {
    @TestVisible static Integer lastPublished = 0;
    global class Request {
        @InvocableVariable(label='Agent Id' required=true) global String workflowId;
        @InvocableVariable(label='Record Id' required=true) global String recordId;
        @InvocableVariable(label='Object API Name') global String objectApiName;
        @InvocableVariable(label='Event' description='created or updated') global String eventType;
    }

    @InvocableMethod(label='Tell Nimbus a record changed' description='Publishes a Nimbus Record Change event; Nimbus starts the agent' category='Nimbus')
    global static void publish(List<Request> requests) {
        List<CRMagents_Change__e> events = new List<CRMagents_Change__e>();
        for (Request r : requests) {
            if (String.isBlank(r.workflowId) || String.isBlank(r.recordId)) {
                continue;
            }
            events.add(new CRMagents_Change__e(
                Workflow_Id__c = r.workflowId.left(36),
                Record_Id__c = r.recordId.left(18),
                Object__c = String.isBlank(r.objectApiName) ? null : r.objectApiName.left(80),
                Event__c = String.isBlank(r.eventType) ? null : r.eventType.left(20)
            ));
        }
        lastPublished = events.size();
        if (!events.isEmpty()) {
            System.EventBus.publish(events);
        }
    }
}

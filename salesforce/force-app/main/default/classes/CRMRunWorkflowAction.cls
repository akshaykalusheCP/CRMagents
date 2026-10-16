/**
 * Flow action: Run a CRMagents workflow. In a record-triggered flow use the asynchronous path,
 * because this makes a callout.
 */
public with sharing class CRMRunWorkflowAction {
    public class Request {
        @InvocableVariable(label='Agent name' description='The agent\'s name in CRMagents (or use Agent Id)')
        public String workflowName;
        @InvocableVariable(label='Agent Id' description='Id shown in the CRMagents app (or use Agent name)')
        public String workflowId;
        @InvocableVariable(label='Record Id')
        public String recordId;
        @InvocableVariable(label='Object API Name')
        public String objectApiName;
        @InvocableVariable(label='Input text')
        public String input;
        @InvocableVariable(label='Wait up to (seconds)' description='0 returns immediately; up to 90 waits for the result')
        public Integer waitSeconds;
    }
    public class Result {
        @InvocableVariable(label='Run Id') public String runId;
        @InvocableVariable(label='Status') public String status;
        @InvocableVariable(label='Output') public String output;
        @InvocableVariable(label='Error') public String error;
    }

    @InvocableMethod(label='Run CRMagents agent' description='Starts a CRMagents agent on a record and optionally waits for its result' category='CRMagents')
    public static List<Result> run(List<Request> requests) {
        // Many records at once (data loads, mass updates): one callout starts them all. Salesforce allows only 100
        // callouts per transaction, so one per record would fail the whole load.
        Boolean anyWait = false;
        for (Request r : requests) {
            anyWait = anyWait || (r.waitSeconds != null && r.waitSeconds > 0);
        }
        if (requests.size() > 1 && !anyWait) {
            return runBatch(requests);
        }
        List<Result> out = new List<Result>();
        for (Request r : requests) {
            Result res = new Result();
            try {
                CRMAgentsController.RunInfo info = CRMAgentsController.run(r.workflowId, r.workflowName, r.recordId, r.objectApiName, r.input, r.waitSeconds);
                res.runId = info.runId;
                res.status = info.status;
                res.output = info.output;
                res.error = info.error;
            } catch (Exception e) {
                res.status = 'error';
                res.error = e.getMessage();
            }
            out.add(res);
        }
        return out;
    }

    static List<Result> runBatch(List<Request> requests) {
        List<Result> out = new List<Result>();
        List<Object> items = new List<Object>();
        for (Request r : requests) {
            Map<String, Object> m = new Map<String, Object>{ 'userEmail' => System.UserInfo.getUserEmail() };
            if (String.isNotBlank(r.workflowId)) m.put('workflowId', r.workflowId);
            if (String.isNotBlank(r.workflowName)) m.put('workflowName', r.workflowName);
            if (String.isNotBlank(r.recordId)) m.put('recordId', r.recordId);
            if (String.isNotBlank(r.objectApiName)) m.put('objectApiName', r.objectApiName);
            if (String.isNotBlank(r.input)) m.put('input', r.input);
            items.add(m);
        }
        try {
            Map<String, Object> resp = (Map<String, Object>) System.JSON.deserializeUntyped(
                CRMClient.okBody(CRMClient.call('POST', '/sf/v1/run/batch', System.JSON.serialize(new Map<String, Object>{ 'items' => items })))
            );
            for (Object o : (List<Object>) resp.get('results')) {
                Map<String, Object> m = (Map<String, Object>) o;
                Result res = new Result();
                res.runId = (String) m.get('runId');
                res.status = (String) m.get('status');
                res.error = (String) m.get('error');
                out.add(res);
            }
        } catch (Exception e) {
            for (Request r : requests) {
                Result res = new Result();
                res.status = 'error';
                res.error = e.getMessage();
                out.add(res);
            }
        }
        return out;
    }
}

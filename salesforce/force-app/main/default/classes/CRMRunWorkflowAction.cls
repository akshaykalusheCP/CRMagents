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
}

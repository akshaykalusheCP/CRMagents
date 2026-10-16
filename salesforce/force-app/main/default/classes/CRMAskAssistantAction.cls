/**
 * Flow action: ask a CRMagents assistant a question, optionally about a record, and get the answer back
 * (for example to summarise a case into a field). Makes a callout: use it in an asynchronous path.
 */
public with sharing class CRMAskAssistantAction {
    public class Request {
        @InvocableVariable(label='Assistant name' required=true description='The assistant\'s name in CRMagents')
        public String assistantName;
        @InvocableVariable(label='Question' required=true)
        public String question;
        @InvocableVariable(label='Record Id' description='The assistant can read this record')
        public String recordId;
        @InvocableVariable(label='Object API Name')
        public String objectApiName;
    }
    public class Result {
        @InvocableVariable(label='Answer') public String answer;
        @InvocableVariable(label='Error') public String error;
    }

    @InvocableMethod(label='Ask CRMagents assistant' description='Asks a CRMagents assistant and returns its answer' category='CRMagents')
    public static List<Result> ask(List<Request> requests) {
        List<Result> out = new List<Result>();
        for (Request r : requests) {
            Result res = new Result();
            // Salesforce allows 100 callouts and 120 seconds of callout time per transaction. Answers that would
            // go over are returned as errors instead of failing the whole transaction.
            if (System.Limits.getCallouts() >= System.Limits.getLimitCallouts() - 1 || CRMClient.remainingCalloutMs < 15000) {
                res.error = 'Not asked: Salesforce\'s callout time limit for one transaction was reached. For many records, use the "Run CRMagents agent" action instead (it works in the background).';
                out.add(res);
                continue;
            }
            try {
                Map<String, Object> body = CRMAgentsController.askBody(null, r.assistantName, r.question, r.recordId, r.objectApiName, null, false);
                Map<String, Object> m = (Map<String, Object>) System.JSON.deserializeUntyped(
                    CRMClient.okBody(CRMClient.call('POST', '/sf/v1/ask', System.JSON.serialize(body)))
                );
                res.answer = (String) m.get('answer');
            } catch (Exception e) {
                res.error = e.getMessage();
            }
            out.add(res);
        }
        return out;
    }
}

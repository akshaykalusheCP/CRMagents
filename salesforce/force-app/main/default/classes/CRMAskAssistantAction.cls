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
            try {
                Map<String, Object> body = new Map<String, Object>{ 'assistantName' => r.assistantName, 'question' => r.question };
                if (String.isNotBlank(r.recordId)) {
                    body.put('recordId', r.recordId);
                }
                if (String.isNotBlank(r.objectApiName)) {
                    body.put('objectApiName', r.objectApiName);
                }
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

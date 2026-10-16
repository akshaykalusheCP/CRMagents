public with sharing class CRMAgentsController {
    public class WorkflowInfo {
        @AuraEnabled public String id;
        @AuraEnabled public String name;
    }
    public class StepInfo {
        @AuraEnabled public String label;
        @AuraEnabled public String status;
    }
    public class RunInfo {
        @AuraEnabled public String runId;
        @AuraEnabled public String status;
        @AuraEnabled public String output;
        @AuraEnabled public String error;
        @AuraEnabled public String approval;
        @AuraEnabled public List<StepInfo> steps = new List<StepInfo>();
    }

    @AuraEnabled
    public static List<WorkflowInfo> listWorkflows(String objectApiName) {
        try {
            String path = '/sf/v1/workflows';
            if (String.isNotBlank(objectApiName)) {
                path += '?object=' + System.EncodingUtil.urlEncode(objectApiName, 'UTF-8');
            }
            List<Object> raw = (List<Object>) System.JSON.deserializeUntyped(CRMClient.okBody(CRMClient.call('GET', path, null)));
            List<WorkflowInfo> out = new List<WorkflowInfo>();
            for (Object o : raw) {
                Map<String, Object> m = (Map<String, Object>) o;
                WorkflowInfo w = new WorkflowInfo();
                w.id = (String) m.get('id');
                w.name = (String) m.get('name');
                out.add(w);
            }
            return out;
        } catch (Exception e) {
            throw fail(e);
        }
    }

    @AuraEnabled
    public static RunInfo startRun(String workflowId, String recordId, String objectApiName, String input) {
        try {
            return run(workflowId, recordId, objectApiName, input, 0);
        } catch (Exception e) {
            throw fail(e);
        }
    }

    @AuraEnabled
    public static RunInfo getRun(String runId) {
        try {
            return parse(CRMClient.okBody(CRMClient.call('GET', '/sf/v1/runs/' + System.EncodingUtil.urlEncode(runId, 'UTF-8'), null)));
        } catch (Exception e) {
            throw fail(e);
        }
    }

    @AuraEnabled
    public static RunInfo decide(String runId, Boolean approve) {
        try {
            String body = System.JSON.serialize(new Map<String, Object>{ 'approve' => approve == true });
            return parse(CRMClient.okBody(CRMClient.call('POST', '/sf/v1/runs/' + System.EncodingUtil.urlEncode(runId, 'UTF-8') + '/decision', body)));
        } catch (Exception e) {
            throw fail(e);
        }
    }

    /** Everything the panel shows for one record: agents, assistants, approvals and recent runs (one callout). */
    @AuraEnabled
    public static String home(String recordId, String objectApiName) {
        try {
            String path = '/sf/v1/home?user=' + System.EncodingUtil.urlEncode(System.UserInfo.getUserEmail(), 'UTF-8');
            if (String.isNotBlank(objectApiName)) {
                path += '&object=' + System.EncodingUtil.urlEncode(objectApiName, 'UTF-8');
            }
            if (String.isNotBlank(recordId)) {
                path += '&recordId=' + System.EncodingUtil.urlEncode(recordId, 'UTF-8');
            }
            return CRMClient.okBody(CRMClient.call('GET', path, null));
        } catch (Exception e) {
            throw fail(e);
        }
    }

    /** Ask an assistant, optionally about this record. historyJson: [{"role":"user|assistant","text":"..."}]. */
    @AuraEnabled
    public static String ask(String assistantId, String question, String recordId, String objectApiName, String historyJson) {
        try {
            Map<String, Object> body = new Map<String, Object>{ 'assistantId' => assistantId, 'question' => question };
            if (String.isNotBlank(recordId)) {
                body.put('recordId', recordId);
            }
            if (String.isNotBlank(objectApiName)) {
                body.put('objectApiName', objectApiName);
            }
            if (String.isNotBlank(historyJson)) {
                body.put('history', System.JSON.deserializeUntyped(historyJson));
            }
            return CRMClient.okBody(CRMClient.call('POST', '/sf/v1/ask', System.JSON.serialize(body)));
        } catch (Exception e) {
            throw fail(e);
        }
    }

    /** Approve or reject, as the signed-in Salesforce user, with an optional note. */
    @AuraEnabled
    public static RunInfo decideWithNote(String runId, Boolean approve, String note) {
        try {
            Map<String, Object> body = new Map<String, Object>{ 'approve' => approve == true, 'userEmail' => System.UserInfo.getUserEmail() };
            if (String.isNotBlank(note)) {
                body.put('note', note);
            }
            return parse(CRMClient.okBody(CRMClient.call('POST', '/sf/v1/runs/' + System.EncodingUtil.urlEncode(runId, 'UTF-8') + '/decision', System.JSON.serialize(body))));
        } catch (Exception e) {
            throw fail(e);
        }
    }

    /** Shared by the LWC and the Flow action. waitSeconds > 0 makes the platform wait for the result. */
    public static RunInfo run(String workflowId, String recordId, String objectApiName, String input, Integer waitSeconds) {
        return run(workflowId, null, recordId, objectApiName, input, waitSeconds);
    }

    /** By agent id, or by its name (easier to use in Flow Builder). */
    public static RunInfo run(String workflowId, String workflowName, String recordId, String objectApiName, String input, Integer waitSeconds) {
        Map<String, Object> body = new Map<String, Object>{ 'userEmail' => System.UserInfo.getUserEmail() };
        if (String.isNotBlank(workflowId)) {
            body.put('workflowId', workflowId);
        }
        if (String.isNotBlank(workflowName)) {
            body.put('workflowName', workflowName);
        }
        if (String.isNotBlank(recordId)) {
            body.put('recordId', recordId);
        }
        if (String.isNotBlank(objectApiName)) {
            body.put('objectApiName', objectApiName);
        }
        if (String.isNotBlank(input)) {
            body.put('input', input);
        }
        if (waitSeconds != null && waitSeconds > 0) {
            body.put('waitSeconds', waitSeconds);
        }
        return parse(CRMClient.okBody(CRMClient.call('POST', '/sf/v1/run', System.JSON.serialize(body))));
    }

    static RunInfo parse(String payload) {
        Map<String, Object> m = (Map<String, Object>) System.JSON.deserializeUntyped(payload);
        RunInfo r = new RunInfo();
        r.runId = (String) m.get('runId');
        r.status = (String) m.get('status');
        r.output = (String) m.get('output');
        r.error = (String) m.get('error');
        r.approval = (String) m.get('approval');
        if (m.get('steps') != null) {
            for (Object o : (List<Object>) m.get('steps')) {
                Map<String, Object> sm = (Map<String, Object>) o;
                StepInfo s = new StepInfo();
                s.label = (String) sm.get('label');
                s.status = (String) sm.get('status');
                r.steps.add(s);
            }
        }
        return r;
    }

    static System.AuraHandledException fail(Exception e) {
        System.AuraHandledException a = new System.AuraHandledException(e.getMessage());
        a.setMessage(e.getMessage());
        return a;
    }
}

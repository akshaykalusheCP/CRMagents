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

    /** Shared by the LWC and the Flow action. waitSeconds > 0 makes the platform wait for the result. */
    public static RunInfo run(String workflowId, String recordId, String objectApiName, String input, Integer waitSeconds) {
        Map<String, Object> body = new Map<String, Object>{ 'workflowId' => workflowId };
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

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
            // Started by this person: the agent may only change what they could change themselves.
            return run(workflowId, null, recordId, objectApiName, input, 0, true);
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

    /** Ask an assistant, optionally about this record, and wait for the answer. historyJson: [{"role":"user|assistant","text":"..."}]. */
    @AuraEnabled
    public static String ask(String assistantId, String question, String recordId, String objectApiName, String historyJson) {
        try {
            return CRMClient.okBody(CRMClient.call('POST', '/sf/v1/ask', System.JSON.serialize(askBody(assistantId, null, question, recordId, objectApiName, historyJson, false))));
        } catch (Exception e) {
            throw fail(e);
        }
    }

    /**
     * Starts a question and returns {"runId": ...} right away; the panel then checks askResult. Nothing waits on
     * the AI inside Salesforce, so long answers can't hit the 120-second callout limit or hold a request open.
     */
    @AuraEnabled
    public static String startAsk(String assistantId, String question, String recordId, String objectApiName, String historyJson) {
        return startChat(assistantId, question, recordId, objectApiName, historyJson, null);
    }

    /** Like startAsk, continuing a saved conversation (null = a new one). The reply carries the conversation id. */
    @AuraEnabled
    public static String startChat(String assistantId, String question, String recordId, String objectApiName, String historyJson, String conversationId) {
        try {
            Map<String, Object> body = askBody(assistantId, null, question, recordId, objectApiName, historyJson, true);
            if (String.isNotBlank(conversationId)) {
                body.put('conversationId', conversationId);
            }
            // The assistant's Salesforce tools run here, as this user (execTools).
            body.put('inOrg', true);
            body.put('userEmail', System.UserInfo.getUserEmail());
            return CRMClient.okBody(CRMClient.call('POST', '/sf/v1/ask', System.JSON.serialize(body), 30000));
        } catch (Exception e) {
            throw fail(e);
        }
    }

    /** This person's last conversation on the record (to continue it) and the notes agents kept on the record. */
    @AuraEnabled
    public static String chatContext(String recordId, String assistantId) {
        try {
            String q = '?userEmail=' + System.EncodingUtil.urlEncode(System.UserInfo.getUserEmail(), 'UTF-8');
            if (String.isNotBlank(recordId)) {
                q += '&recordId=' + System.EncodingUtil.urlEncode(recordId, 'UTF-8');
            }
            if (String.isNotBlank(assistantId)) {
                q += '&assistantId=' + System.EncodingUtil.urlEncode(assistantId, 'UTF-8');
            }
            return CRMClient.okBody(CRMClient.call('GET', '/sf/v1/conversations' + q, null, 30000));
        } catch (Exception e) {
            throw fail(e);
        }
    }

    /** {"status": "running" | "done" | "error", "answer": "..."} for a question started with startAsk. */
    @AuraEnabled
    public static String askResult(String runId) {
        try {
            return CRMClient.okBody(CRMClient.call('GET', '/sf/v1/ask/' + System.EncodingUtil.urlEncode(runId, 'UTF-8'), null, 30000));
        } catch (Exception e) {
            throw fail(e);
        }
    }

    /** Runs an assistant's tool calls as this user. No callout here: Salesforce doesn't allow one after a change. */
    @AuraEnabled
    public static String execTools(String callsJson) {
        try {
            return CRMToolRunner.run(callsJson);
        } catch (Exception e) {
            throw fail(e);
        }
    }

    /** Sends the results of execTools back to Nimbus (a separate request, after the changes are saved). */
    @AuraEnabled
    public static void postToolResults(String runId, String resultsJson) {
        try {
            CRMClient.okBody(CRMClient.call('POST', '/sf/v1/ask/' + System.EncodingUtil.urlEncode(runId, 'UTF-8') + '/tools',
                System.JSON.serialize(new Map<String, Object>{ 'results' => System.JSON.deserializeUntyped(resultsJson) }), 30000));
        } catch (Exception e) {
            throw fail(e);
        }
    }

    public static Map<String, Object> askBody(String assistantId, String assistantName, String question, String recordId, String objectApiName, String historyJson, Boolean async) {
        Map<String, Object> body = new Map<String, Object>{ 'question' => question };
        if (String.isNotBlank(assistantId)) {
            body.put('assistantId', assistantId);
        }
        if (String.isNotBlank(assistantName)) {
            body.put('assistantName', assistantName);
        }
        if (String.isNotBlank(recordId)) {
            body.put('recordId', recordId);
            Map<String, Object> rec = recordFor(recordId);
            if (rec != null) {
                body.put('record', rec);
            }
        }
        if (String.isNotBlank(objectApiName)) {
            body.put('objectApiName', objectApiName);
        }
        if (String.isNotBlank(historyJson)) {
            body.put('history', System.JSON.deserializeUntyped(historyJson));
        }
        if (async == true) {
            body.put('async', true);
        }
        return body;
    }

    static final Set<String> SKIP_FIELDS = new Set<String>{ 'IsDeleted', 'SystemModstamp', 'LastViewedDate', 'LastReferencedDate', 'PhotoUrl', 'MasterRecordId', 'Jigsaw', 'JigsawContactId', 'CleanStatus' };
    static final Integer MAX_TEXT = 4000;

    /**
     * The record as the signed-in user may see it (field-level security applies), read inside Salesforce:
     * queries inside the org don't use the API allowance, so Nimbus doesn't need to call back for it.
     */
    public static Map<String, Object> recordFor(String recordId) {
        try {
            Id rid = (Id) recordId;
            Schema.DescribeSObjectResult d = rid.getSObjectType().getDescribe();
            List<String> fields = new List<String>();
            for (Schema.SObjectField f : d.fields.getMap().values()) {
                Schema.DescribeFieldResult fd = f.getDescribe();
                Schema.DisplayType t = fd.getType();
                if (!fd.isAccessible() || SKIP_FIELDS.contains(fd.getName())) {
                    continue;
                }
                if (t == Schema.DisplayType.BASE64 || t == Schema.DisplayType.ADDRESS || t == Schema.DisplayType.LOCATION || t == Schema.DisplayType.ENCRYPTEDSTRING) {
                    continue;
                }
                fields.add(fd.getName());
                if (fields.size() >= 150) {
                    break;
                }
            }
            List<SObject> rows = System.Database.queryWithBinds(
                'SELECT ' + String.join(fields, ',') + ' FROM ' + d.getName() + ' WHERE Id = :rid LIMIT 1',
                new Map<String, Object>{ 'rid' => rid }, AccessLevel.USER_MODE
            );
            if (rows.isEmpty()) {
                return null;
            }
            Map<String, Object> out = new Map<String, Object>();
            for (String k : rows[0].getPopulatedFieldsAsMap().keySet()) {
                Object v = rows[0].get(k);
                if (v == null) {
                    continue;
                }
                if (v instanceof String && ((String) v).length() > MAX_TEXT) {
                    v = ((String) v).left(MAX_TEXT) + '…';
                }
                out.put(k, v);
            }
            return out;
        } catch (Exception e) {
            return null; // Nimbus reads the record itself instead
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

    /** Suggestions agents saved on this record (JSON list), for the Suggestions card. */
    @AuraEnabled
    public static String suggestions(String recordId) {
        try {
            return CRMClient.okBody(CRMClient.call('GET', '/sf/v1/suggestions?recordId=' + System.EncodingUtil.urlEncode(recordId, 'UTF-8'), null));
        } catch (Exception e) {
            throw fail(e);
        }
    }

    /**
     * Sends an agent's suggested email reply as the signed-in user (they may have edited it), then marks the
     * suggestion as used. Email first (no callout before it), the Nimbus update after.
     */
    @AuraEnabled
    public static void sendSuggestedReply(String suggestionId, String caseId, String toAddress, String subject, String body, String inReplyToId) {
        try {
            String html = body == null ? '' : body.escapeHtml4().replace('\n', '<br/>');
            CRMCaseEmail.send(caseId, toAddress, subject, html, inReplyToId);
        } catch (Exception e) {
            throw fail(e);
        }
    }

    @AuraEnabled
    public static void markSuggestionSent(String suggestionId) {
        try {
            String body = System.JSON.serialize(new Map<String, Object>{ 'status' => 'sent', 'userEmail' => System.UserInfo.getUserEmail() });
            CRMClient.okBody(CRMClient.call('POST', '/sf/v1/suggestions/' + System.EncodingUtil.urlEncode(suggestionId, 'UTF-8'), body));
        } catch (Exception e) {
            throw fail(e);
        }
    }

    /** What agents changed on this record (read inside Salesforce: no callout, no API use). */
    @AuraEnabled
    public static List<CRMagents_Agent_Activity__c> activity(String recordId) {
        try {
            String id15 = String.isBlank(recordId) ? '' : recordId.left(15);
            return [
                SELECT Name, Agent__c, Changes__c, On_Behalf_Of__r.Name, Started_By__c, Approved_By__c, Status__c, CreatedDate
                FROM CRMagents_Agent_Activity__c WHERE Record_Id__c IN (:recordId, :id15)
                WITH USER_MODE ORDER BY CreatedDate DESC LIMIT 10
            ];
        } catch (Exception e) {
            throw fail(e);
        }
    }

    /** What agents changed on this record, with old and new values (from Nimbus' change log). */
    @AuraEnabled
    public static String recordChanges(String recordId) {
        try {
            return CRMClient.okBody(CRMClient.call('GET', '/sf/v1/changes?recordId=' + System.EncodingUtil.urlEncode(recordId, 'UTF-8'), null));
        } catch (Exception e) {
            throw fail(e);
        }
    }

    /** Undo agent changes, as the signed-in user: Nimbus checks they may edit those records. */
    @AuraEnabled
    public static String undoChanges(String changeIdsJson) {
        try {
            Map<String, Object> body = new Map<String, Object>{
                'changeIds' => System.JSON.deserializeUntyped(changeIdsJson),
                'userId' => System.UserInfo.getUserId(),
                'userEmail' => System.UserInfo.getUserEmail()
            };
            return CRMClient.okBody(CRMClient.call('POST', '/sf/v1/undo', System.JSON.serialize(body)));
        } catch (Exception e) {
            throw fail(e);
        }
    }

    /** Feedback on a suggestion: helpful, not_helpful or dismissed, recorded with the user's email. */
    @AuraEnabled
    public static void rateSuggestion(String suggestionId, String status) {
        try {
            String body = System.JSON.serialize(new Map<String, Object>{ 'status' => status, 'userEmail' => System.UserInfo.getUserEmail() });
            CRMClient.okBody(CRMClient.call('POST', '/sf/v1/suggestions/' + System.EncodingUtil.urlEncode(suggestionId, 'UTF-8'), body));
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
        return run(workflowId, workflowName, recordId, objectApiName, input, waitSeconds, false);
    }

    public static RunInfo run(String workflowId, String workflowName, String recordId, String objectApiName, String input, Integer waitSeconds, Boolean asUser) {
        Map<String, Object> body = new Map<String, Object>{ 'userEmail' => System.UserInfo.getUserEmail() };
        if (asUser == true) {
            body.put('userId', System.UserInfo.getUserId());
        }
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

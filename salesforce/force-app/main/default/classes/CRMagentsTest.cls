@IsTest
private class CRMagentsTest {
    private class Mock implements System.HttpCalloutMock {
        Integer status;
        public String body;
        System.HttpRequest last;
        Mock(Integer status, String body) {
            this.status = status;
            this.body = body;
        }
        public System.HttpResponse respond(System.HttpRequest req) {
            last = req;
            System.HttpResponse res = new System.HttpResponse();
            res.setStatusCode(status);
            res.setBody(body);
            return res;
        }
    }

    private static void configure() {
        insert new CRMagents_Config__c(SetupOwnerId = System.UserInfo.getOrganizationId(), Base_Url__c = 'https://example.test/', Signing_Secret__c = 'secret');
    }

    @IsTest
    static void listsWorkflowsAndSignsRequests() {
        configure();
        Mock m = new Mock(200, '[{"id":"w1","name":"Case triage"}]');
        System.Test.setMock(System.HttpCalloutMock.class, m);
        System.Test.startTest();
        List<CRMAgentsController.WorkflowInfo> w = CRMAgentsController.listWorkflows('Case');
        System.Test.stopTest();
        System.assertEquals(1, w.size());
        System.assertEquals('Case triage', w[0].name);
        System.assertEquals('https://example.test/sf/v1/workflows?object=Case', m.last.getEndpoint());
        System.assertEquals(System.UserInfo.getOrganizationId(), m.last.getHeader('X-CRM-Org'));
        System.assertEquals(64, m.last.getHeader('X-CRM-Signature').length());
        System.assertNotEquals(null, m.last.getHeader('X-CRM-Timestamp'));
    }

    @IsTest
    static void startsAndReadsRuns() {
        configure();
        String run = '{"runId":"r1","status":"waiting","output":"","approval":"Create task?","steps":[{"label":"AI","status":"ok","ms":3}]}';
        System.Test.setMock(System.HttpCalloutMock.class, new Mock(200, run));
        System.Test.startTest();
        CRMAgentsController.RunInfo a = CRMAgentsController.startRun('w1', '500000000000001', 'Case', 'hi');
        CRMAgentsController.RunInfo b = CRMAgentsController.getRun('r1');
        CRMAgentsController.RunInfo c = CRMAgentsController.decide('r1', true);
        System.Test.stopTest();
        System.assertEquals('waiting', a.status);
        System.assertEquals('Create task?', b.approval);
        System.assertEquals(1, c.steps.size());
    }

    @IsTest
    static void flowActionReturnsResultAndCapturesErrors() {
        configure();
        System.Test.setMock(System.HttpCalloutMock.class, new Mock(200, '{"runId":"r2","status":"done","output":"ok","steps":[]}'));
        CRMRunWorkflowAction.Request req = new CRMRunWorkflowAction.Request();
        req.workflowId = 'w1';
        req.waitSeconds = 30;
        System.Test.startTest();
        List<CRMRunWorkflowAction.Result> ok = CRMRunWorkflowAction.run(new List<CRMRunWorkflowAction.Request>{ req });
        System.Test.setMock(System.HttpCalloutMock.class, new Mock(401, '{"error":"unauthorized"}'));
        List<CRMRunWorkflowAction.Result> bad = CRMRunWorkflowAction.run(new List<CRMRunWorkflowAction.Request>{ req });
        System.Test.stopTest();
        System.assertEquals('ok', ok[0].output);
        System.assertEquals('error', bad[0].status);
        System.assertEquals('unauthorized', bad[0].error);
    }

    @IsTest
    static void failsClearlyWhenNotConnected() {
        try {
            CRMAgentsController.listWorkflows('Case');
            System.assert(false, 'expected an error');
        } catch (System.AuraHandledException e) {
            System.assert(e.getMessage().contains('not connected'));
        }
    }

    @IsTest
    static void homeAskAndDecideWithNote() {
        configure();
        Mock m = new Mock(200, '{"agents":[],"assistants":[],"approvals":[],"recent":[]}');
        System.Test.setMock(System.HttpCalloutMock.class, m);
        System.Test.startTest();
        String h = CRMAgentsController.home('500000000000001', 'Case');
        System.assert(h.contains('agents'));
        System.assert(m.last.getEndpoint().contains('/sf/v1/home?user='));
        System.assert(m.last.getEndpoint().contains('&object=Case&recordId=500000000000001'));
        m.body = '{"answer":"4 open cases","runId":"r9"}';
        String a = CRMAgentsController.ask('a1', 'How many?', '500000000000001', 'Case', '[{"role":"user","text":"hi"}]');
        System.assert(a.contains('4 open cases'));
        System.assert(m.last.getBody().contains('"history"'));
        m.body = '{"runId":"r1","status":"done","output":"ok","steps":[]}';
        CRMAgentsController.RunInfo d = CRMAgentsController.decideWithNote('r1', false, 'wrong category');
        System.Test.stopTest();
        System.assertEquals('done', d.status);
        System.assert(m.last.getBody().contains('wrong category'));
        System.assert(m.last.getBody().contains('userEmail'));
    }

    @IsTest
    static void runsByNameAndAsksFromFlow() {
        configure();
        Mock m = new Mock(200, '{"runId":"r3","status":"done","output":"ok","steps":[]}');
        System.Test.setMock(System.HttpCalloutMock.class, m);
        CRMRunWorkflowAction.Request req = new CRMRunWorkflowAction.Request();
        req.workflowName = 'Case triage';
        req.recordId = '500000000000001';
        System.Test.startTest();
        List<CRMRunWorkflowAction.Result> ran = CRMRunWorkflowAction.run(new List<CRMRunWorkflowAction.Request>{ req });
        System.assert(m.last.getBody().contains('"workflowName":"Case triage"'));
        m.body = '{"answer":"Customer is upset about a late refund."}';
        CRMAskAssistantAction.Request q = new CRMAskAssistantAction.Request();
        q.assistantName = 'Support analyst';
        q.question = 'Summarise this case';
        q.recordId = '500000000000001';
        q.objectApiName = 'Case';
        List<CRMAskAssistantAction.Result> ans = CRMAskAssistantAction.ask(new List<CRMAskAssistantAction.Request>{ q });
        System.Test.setMock(System.HttpCalloutMock.class, new Mock(404, '{"error":"Assistant not found"}'));
        List<CRMAskAssistantAction.Result> bad = CRMAskAssistantAction.ask(new List<CRMAskAssistantAction.Request>{ q });
        System.Test.stopTest();
        System.assertEquals('ok', ran[0].output);
        System.assertEquals('Customer is upset about a late refund.', ans[0].answer);
        System.assertEquals('Assistant not found', bad[0].error);
    }

    @IsTest
    static void suggestionsAndFeedback() {
        configure();
        Mock m = new Mock(200, '[{"id":"s1","title":"Suggested resolution","body":"Restart the router [1]."}]');
        System.Test.setMock(System.HttpCalloutMock.class, m);
        System.Test.startTest();
        String list1 = CRMAgentsController.suggestions('500000000000001');
        System.assert(list1.contains('Suggested resolution'));
        System.assert(m.last.getEndpoint().contains('/sf/v1/suggestions?recordId=500000000000001'));
        m.body = '{"ok":true}';
        CRMAgentsController.rateSuggestion('s1', 'helpful');
        System.Test.stopTest();
        System.assert(m.last.getEndpoint().contains('/sf/v1/suggestions/s1'));
        System.assert(m.last.getBody().contains('helpful'));
        System.assert(m.last.getBody().contains('userEmail'));
    }

    @IsTest
    static void continuesConversationsAndReadsChatContext() {
        configure();
        Mock m = new Mock(200, '{"runId":"r9","status":"running","conversationId":"c1"}');
        System.Test.setMock(System.HttpCalloutMock.class, m);
        System.Test.startTest();
        String started = CRMAgentsController.startChat('a1', 'And the oldest?', null, null, null, 'c1');
        System.assert(started.contains('c1'));
        System.assert(m.last.getBody().contains('"conversationId":"c1"'), m.last.getBody());
        m.body = '{"conversations":[],"latest":null,"notes":[]}';
        CRMAgentsController.chatContext('500000000000001', 'a1');
        System.Test.stopTest();
        System.assert(m.last.getEndpoint().contains('/sf/v1/conversations?userEmail='));
        System.assert(m.last.getEndpoint().contains('recordId=500000000000001'));
    }

    @IsTest
    static void recordChangesAndUndoAsTheUser() {
        configure();
        Mock m = new Mock(200, '[{"runId":"r1","agent":"Case triage","open":1,"changes":[{"id":7,"lines":["Priority: Low → High"]}]}]');
        System.Test.setMock(System.HttpCalloutMock.class, m);
        System.Test.startTest();
        String changes = CRMAgentsController.recordChanges('500000000000001');
        System.assert(changes.contains('Case triage'));
        System.assert(m.last.getEndpoint().contains('/sf/v1/changes?recordId=500000000000001'));
        m.body = '{"restored":1,"deleted":0,"recovered":0,"skipped":[],"failed":[]}';
        String rep = CRMAgentsController.undoChanges('[7]');
        System.Test.stopTest();
        System.assert(rep.contains('"restored":1'));
        System.assert(m.last.getEndpoint().endsWith('/sf/v1/undo'));
        // Who is asking goes along, so Nimbus checks their access to the record.
        System.assert(m.last.getBody().contains(System.UserInfo.getUserId()), m.last.getBody());
        System.assert(m.last.getBody().contains('"changeIds":[7]'), m.last.getBody());
    }

    @IsTest
    static void asksInBackgroundWithRecordReadInOrg() {
        configure();
        Account a = new Account(Name = 'Acme Test', Description = 'Big customer');
        insert a;
        Mock m = new Mock(200, '{"runId":"r5","status":"running"}');
        System.Test.setMock(System.HttpCalloutMock.class, m);
        System.Test.startTest();
        String started = CRMAgentsController.startAsk('a1', 'Summarise', a.Id, 'Account', null);
        System.assert(started.contains('r5'));
        // The record goes along (read inside Salesforce), so Nimbus doesn't call back for it.
        System.assert(m.last.getBody().contains('Acme Test'), m.last.getBody());
        System.assert(m.last.getBody().contains('"async":true'));
        m.body = '{"status":"done","answer":"Acme is a big customer."}';
        String r = CRMAgentsController.askResult('r5');
        System.Test.stopTest();
        System.assert(r.contains('big customer'));
        System.assert(m.last.getEndpoint().contains('/sf/v1/ask/r5'));
    }

    @IsTest
    static void manyRecordsStartInOneCallout() {
        configure();
        Mock m = new Mock(200, '{"results":[{"runId":"r1","status":"queued"},{"runId":"r2","status":"queued"},{"runId":"r3","status":"queued"}]}');
        System.Test.setMock(System.HttpCalloutMock.class, m);
        List<CRMRunWorkflowAction.Request> reqs = new List<CRMRunWorkflowAction.Request>();
        for (Integer i = 0; i < 3; i++) {
            CRMRunWorkflowAction.Request q = new CRMRunWorkflowAction.Request();
            q.workflowName = 'Triage';
            q.recordId = '50000000000000' + i;
            reqs.add(q);
        }
        System.Test.startTest();
        List<CRMRunWorkflowAction.Result> res = CRMRunWorkflowAction.run(reqs);
        System.assertEquals(1, System.Limits.getCallouts());
        System.Test.stopTest();
        System.assertEquals(3, res.size());
        System.assertEquals('r3', res[2].runId);
        System.assertEquals('queued', res[0].status);
        System.assert(m.last.getEndpoint().endsWith('/sf/v1/run/batch'));
    }

    @IsTest
    static void askActionStopsBeforeTheCalloutTimeLimit() {
        configure();
        System.Test.setMock(System.HttpCalloutMock.class, new Mock(200, '{"answer":"ok","runId":"r1"}'));
        CRMAskAssistantAction.Request q = new CRMAskAssistantAction.Request();
        q.assistantName = 'Casey';
        q.question = 'Summarise';
        System.Test.startTest();
        CRMClient.remainingCalloutMs = 5000; // as if earlier answers used most of the 120 seconds
        List<CRMAskAssistantAction.Result> res = CRMAskAssistantAction.ask(new List<CRMAskAssistantAction.Request>{ q });
        System.Test.stopTest();
        System.assert(res[0].error.contains('callout time limit'), res[0].error);
        System.assertEquals(null, res[0].answer);
    }

    @IsTest
    static void showsAgentActivityForARecord() {
        Account a = new Account(Name = 'Audit Co');
        insert a;
        // Nimbus writes activity (Integration permission set); people read it (User permission set).
        User u = new User(Id = System.UserInfo.getUserId());
        List<PermissionSetAssignment> add = new List<PermissionSetAssignment>();
        for (PermissionSet ps : [SELECT Id FROM PermissionSet WHERE Name IN ('CRMagents_User', 'CRMagents_Integration')]) {
            if ([SELECT COUNT() FROM PermissionSetAssignment WHERE AssigneeId = :u.Id AND PermissionSetId = :ps.Id] == 0) {
                add.add(new PermissionSetAssignment(AssigneeId = u.Id, PermissionSetId = ps.Id));
            }
        }
        insert add;
        List<CRMagents_Agent_Activity__c> rows;
        System.runAs(u) {
            insert new CRMagents_Agent_Activity__c(Agent__c = 'Triage', Record_Id__c = a.Id, Changes__c = 'Update Account: Rating = Hot', Status__c = 'done');
            rows = CRMAgentsController.activity(a.Id);
        }
        System.assertEquals(1, rows.size());
        System.assertEquals('Triage', rows[0].Agent__c);
    }
}

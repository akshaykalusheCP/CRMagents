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
}

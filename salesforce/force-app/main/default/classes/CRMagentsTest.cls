@IsTest
private class CRMagentsTest {
    private class Mock implements System.HttpCalloutMock {
        Integer status;
        String body;
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
}

@IsTest
private class CRMCaseEmailTest {
    static Case caseWithEmail() {
        Case c = new Case(Subject = 'Printer offline', SuppliedEmail = 'ana@example.com');
        insert c;
        insert new EmailMessage(ParentId = c.Id, Incoming = true, FromAddress = 'ana@example.com', ToAddress = 'support@example.com',
            Subject = 'Printer offline', TextBody = 'It stopped working', Status = '0', MessageDate = System.now());
        return c;
    }

    // Some test orgs turn email off (deliverability "No access"); everything else must succeed.
    static Boolean emailOff(String msg) {
        return msg != null && (msg.containsIgnoreCase('deliverability') || msg.containsIgnoreCase('NO_MASS_MAIL_PERMISSION') || msg.containsIgnoreCase('not allowed'));
    }

    @IsTest
    static void repliesInTheThreadToTheCustomer() {
        Case c = caseWithEmail();
        CRMCaseEmail.Request r = new CRMCaseEmail.Request();
        r.caseId = c.Id;
        r.htmlBody = '<p>Please restart it.</p>';
        System.Test.startTest();
        List<CRMCaseEmail.Result> res = CRMCaseEmail.sendReplies(new List<CRMCaseEmail.Request>{ r });
        System.Test.stopTest();
        System.assert(res[0].sent == true || emailOff(res[0].error), res[0].error);
        System.assertEquals('ana@example.com', CRMCaseEmail.lastIncoming(c.Id).FromAddress);
    }

    @IsTest
    static void personSendsTheSuggestedReply() {
        Case c = caseWithEmail();
        System.Test.startTest();
        try {
            CRMAgentsController.sendSuggestedReply('s1', c.Id, null, null, 'Hi Ana,\nPlease restart it.', null);
        } catch (AuraHandledException e) {
            System.assert(emailOff(e.getMessage()), e.getMessage());
        }
        System.Test.stopTest();
    }

    @IsTest
    static void noAddressIsAClearError() {
        Case c = new Case(Subject = 'No email');
        insert c;
        CRMCaseEmail.Request r = new CRMCaseEmail.Request();
        r.caseId = c.Id;
        r.htmlBody = 'x';
        List<CRMCaseEmail.Result> res = CRMCaseEmail.sendReplies(new List<CRMCaseEmail.Request>{ r });
        System.assertEquals(false, res[0].sent);
        System.assert(res[0].error.contains('No email address'), res[0].error);
    }

    @IsTest
    static void marksTheSuggestionSent() {
        insert new CRMagents_Config__c(SetupOwnerId = System.UserInfo.getOrganizationId(), Base_Url__c = 'https://example.test/', Signing_Secret__c = 'secret');
        System.Test.setMock(System.HttpCalloutMock.class, new Ok());
        System.Test.startTest();
        CRMAgentsController.markSuggestionSent('s1');
        System.Test.stopTest();
    }

    private class Ok implements System.HttpCalloutMock {
        public System.HttpResponse respond(System.HttpRequest req) {
            System.assert(req.getBody().contains('"sent"'));
            System.HttpResponse res = new System.HttpResponse();
            res.setStatusCode(200);
            res.setBody('{"ok":true}');
            return res;
        }
    }
}

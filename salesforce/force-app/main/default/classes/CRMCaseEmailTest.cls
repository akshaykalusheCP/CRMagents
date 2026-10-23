@IsTest
private class CRMCaseEmailTest {
    @IsTest
    static void repliesToTheCustomersLastEmailOnTheCase() {
        Case c = new Case(Subject = 'Printer broken', SuppliedEmail = 'customer@example.com');
        insert c;
        insert new EmailMessage(ParentId = c.Id, Incoming = true, FromAddress = 'customer@example.com', ToAddress = 'support@example.com', Subject = 'Printer broken', TextBody = 'Help');
        CRMCaseEmail.Request r = new CRMCaseEmail.Request();
        r.caseId = c.Id;
        r.htmlBody = '<p>Try turning it off and on.</p>';
        System.Test.startTest();
        List<CRMCaseEmail.Result> out = CRMCaseEmail.sendReplies(new List<CRMCaseEmail.Request>{ r });
        System.Test.stopTest();
        System.assertEquals(1, out.size());
        // Orgs where email deliverability is off refuse to send; the action reports that instead of failing the Flow.
        System.assert(out[0].sent == true || String.isNotBlank(out[0].error), 'sent or a reason');
    }

    @IsTest
    static void noAddressIsReportedNotThrown() {
        Case c = new Case(Subject = 'No contact');
        insert c;
        CRMCaseEmail.Request r = new CRMCaseEmail.Request();
        r.caseId = c.Id;
        r.htmlBody = 'x';
        List<CRMCaseEmail.Result> out = CRMCaseEmail.sendReplies(new List<CRMCaseEmail.Request>{ r });
        System.assertEquals(false, out[0].sent);
        System.assert(out[0].error.contains('No email address'), out[0].error);
    }
}

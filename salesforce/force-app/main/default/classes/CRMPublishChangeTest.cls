@IsTest
private class CRMPublishChangeTest {
    @IsTest
    static void publishesOneEventPerRecordInBulk() {
        List<CRMPublishChange.Request> reqs = new List<CRMPublishChange.Request>();
        for (Integer i = 0; i < 200; i++) {
            CRMPublishChange.Request r = new CRMPublishChange.Request();
            r.workflowId = '11111111-2222-3333-4444-555555555555';
            r.recordId = '500000000000' + String.valueOf(1000 + i).left(4) + 'AA';
            r.objectApiName = 'Case';
            r.eventType = 'created';
            reqs.add(r);
        }
        CRMPublishChange.Request blank = new CRMPublishChange.Request();
        reqs.add(blank);
        System.Test.startTest();
        CRMPublishChange.publish(reqs);
        System.Test.stopTest();
        System.Test.getEventBus().deliver();
        System.assertEquals(200, CRMPublishChange.lastPublished, 'one event per record; the blank request is skipped');
    }
}

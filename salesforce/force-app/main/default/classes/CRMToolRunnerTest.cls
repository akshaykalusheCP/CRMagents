@IsTest
private class CRMToolRunnerTest {
    static List<Object> run(List<Map<String, Object>> calls) {
        return (List<Object>) System.JSON.deserializeUntyped(CRMAgentsController.execTools(System.JSON.serialize(calls)));
    }
    static Map<String, Object> call(String name, Map<String, Object> input) {
        return new Map<String, Object>{ 'id' => 't1', 'name' => name, 'input' => input };
    }
    static Map<String, Object> first(List<Object> r) {
        return (Map<String, Object>) r[0];
    }

    @IsTest
    static void readsAndChangesRecordsAsTheUser() {
        Map<String, Object> created = first(run(new List<Map<String, Object>>{ call('create_record', new Map<String, Object>{ 'sobject' => 'Account', 'fields' => new Map<String, Object>{ 'Name' => 'Acme Tools', 'NumberOfEmployees' => '12' } }) }));
        System.assertEquals(true, created.get('ok'), '' + created.get('error'));
        String id = (String) ((Map<String, Object>) created.get('result')).get('id');

        Map<String, Object> q = first(run(new List<Map<String, Object>>{ call('soql_query', new Map<String, Object>{ 'soql' => 'SELECT Id, Name FROM Account WHERE Name = \'Acme Tools\'' }) }));
        System.assertEquals(1, ((Map<String, Object>) q.get('result')).get('totalSize'));

        Map<String, Object> upd = first(run(new List<Map<String, Object>>{ call('update_record', new Map<String, Object>{ 'id' => id, 'fields' => new Map<String, Object>{ 'Description' => 'Updated' } }) }));
        System.assertEquals(true, upd.get('ok'), '' + upd.get('error'));
        System.assertEquals('Updated', [SELECT Description FROM Account WHERE Id = :id].Description);
        // What it replaced is reported, so Nimbus can undo it.
        Map<String, Object> updRes = (Map<String, Object>) upd.get('result');
        System.assertEquals('Account', updRes.get('object'));
        System.assert(((Map<String, Object>) updRes.get('before')).containsKey('Description'), System.JSON.serialize(updRes));
        System.assertEquals(null, ((Map<String, Object>) updRes.get('before')).get('Description'));

        Map<String, Object> got = first(run(new List<Map<String, Object>>{ call('get_record', new Map<String, Object>{ 'sobject' => 'Account', 'id' => id, 'fields' => new List<Object>{ 'Name', 'Description' } }) }));
        System.assertEquals('Acme Tools', ((Map<String, Object>) got.get('result')).get('Name'));

        Map<String, Object> d = first(run(new List<Map<String, Object>>{ call('describe_object', new Map<String, Object>{ 'sobject' => 'Account', 'search' => 'industry' }) }));
        System.assert(System.JSON.serialize(d.get('result')).contains('Industry'));

        insert new ContentVersion(Title = 'Contract', PathOnClient = 'contract.txt', VersionData = Blob.valueOf('Terms'), FirstPublishLocationId = id);
        Map<String, Object> files = first(run(new List<Map<String, Object>>{ call('list_files', new Map<String, Object>{ 'recordId' => id }) }));
        System.assert(System.JSON.serialize(files.get('result')).contains('Contract'), System.JSON.serialize(files));

        Map<String, Object> del = first(run(new List<Map<String, Object>>{ call('delete_record', new Map<String, Object>{ 'id' => id }) }));
        System.assertEquals(true, del.get('ok'));
        Map<String, Object> delRes = (Map<String, Object>) del.get('result');
        System.assertEquals('Acme Tools', ((Map<String, Object>) delRes.get('before')).get('Name'), System.JSON.serialize(delRes));
        System.assertEquals(0, [SELECT COUNT() FROM Account WHERE Id = :id]);
    }

    @IsTest
    static void reportsErrorsWithoutLeavingPartialChanges() {
        Map<String, Object> bad = first(run(new List<Map<String, Object>>{ call('soql_query', new Map<String, Object>{ 'soql' => 'DELETE FROM Account' }) }));
        System.assertEquals(false, bad.get('ok'));
        Map<String, Object> unknown = first(run(new List<Map<String, Object>>{ call('nope', new Map<String, Object>()) }));
        System.assert(((String) unknown.get('error')).contains('Unknown tool'));
        Map<String, Object> noField = first(run(new List<Map<String, Object>>{ call('create_record', new Map<String, Object>{ 'sobject' => 'Account', 'fields' => new Map<String, Object>{ 'Name' => 'X', 'Not_A_Field__c' => '1' } }) }));
        System.assert(((String) noField.get('error')).contains('Unknown field'));
        System.assertEquals(0, [SELECT COUNT() FROM Account WHERE Name = 'X']);
        Map<String, Object> action = first(run(new List<Map<String, Object>>{ call('run_org_action', new Map<String, Object>{ 'action' => 'flow:Does_Not_Exist_Flow', 'inputs' => new Map<String, Object>() }) }));
        System.assertEquals(false, action.get('ok'));
        Map<String, Object> badKey = first(run(new List<Map<String, Object>>{ call('run_org_action', new Map<String, Object>{ 'action' => 'nope' }) }));
        System.assertEquals(false, badKey.get('ok'));
    }

    @IsTest
    static void convertsValuesToFieldTypes() {
        System.assertEquals(Date.newInstance(2026, 10, 16), CRMToolRunner.coerce(Schema.DisplayType.DATE, '2026-10-16'));
        System.assertEquals(true, CRMToolRunner.coerce(Schema.DisplayType.BOOLEAN, 'true'));
        System.assertEquals(5, CRMToolRunner.coerce(Schema.DisplayType.INTEGER, '5'));
        System.assertEquals(2.5, CRMToolRunner.coerce(Schema.DisplayType.CURRENCY, '2.5'));
        System.assertNotEquals(null, CRMToolRunner.coerce(Schema.DisplayType.DATETIME, '2026-10-16T10:00:00.000Z'));
        System.assertEquals(null, CRMToolRunner.coerce(Schema.DisplayType.STRING, null));
    }

    @IsTest
    static void postsToolResults() {
        insert new CRMagents_Config__c(SetupOwnerId = System.UserInfo.getOrganizationId(), Base_Url__c = 'https://example.test/', Signing_Secret__c = 'secret');
        System.Test.setMock(System.HttpCalloutMock.class, new ToolMock());
        System.Test.startTest();
        CRMAgentsController.postToolResults('r1', '[{"id":"t1","ok":true,"result":1}]');
        System.Test.stopTest();
        System.assertEquals('/sf/v1/ask/r1/tools', lastPath);
    }

    private class ToolMock implements System.HttpCalloutMock {
        public System.HttpResponse respond(System.HttpRequest req) {
            CRMToolRunnerTest.lastPath = new System.Url(req.getEndpoint()).getPath();
            System.HttpResponse res = new System.HttpResponse();
            res.setStatusCode(200);
            res.setBody('{"accepted":1}');
            return res;
        }
    }
    static String lastPath;
}

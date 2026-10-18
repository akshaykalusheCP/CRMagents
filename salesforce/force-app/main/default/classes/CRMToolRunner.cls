/**
 * Runs an assistant's Salesforce tool calls as the signed-in user (user mode): their record sharing and field
 * permissions apply, and changes show their name in the field history. Used by the Agent Panel while an
 * assistant answers; no API allowance is used.
 */
public with sharing class CRMToolRunner {
    public class ToolException extends Exception {}

    static final Integer MAX_ROWS = 50;

    /** callsJson: [{"id":"t1","name":"soql_query","input":{...}}] -> [{"id":"t1","ok":true,"result":...}] */
    public static String run(String callsJson) {
        List<Object> out = new List<Object>();
        for (Object o : (List<Object>) System.JSON.deserializeUntyped(callsJson)) {
            Map<String, Object> c = (Map<String, Object>) o;
            Map<String, Object> r = new Map<String, Object>{ 'id' => c.get('id') };
            Map<String, Object> input = c.get('input') == null ? new Map<String, Object>() : (Map<String, Object>) c.get('input');
            // One failed change never leaves half of it behind.
            System.Savepoint sp = Database.setSavepoint();
            try {
                r.put('result', one((String) c.get('name'), input));
                r.put('ok', true);
            } catch (Exception e) {
                Database.rollback(sp);
                r.put('ok', false);
                r.put('error', e.getMessage());
            }
            out.add(r);
        }
        return System.JSON.serialize(out);
    }

    static Object one(String name, Map<String, Object> input) {
        switch on name {
            when 'soql_query' { return query((String) input.get('soql')); }
            when 'get_record' { return getRecord((String) input.get('sobject'), (String) input.get('id'), (List<Object>) input.get('fields')); }
            when 'describe_object' { return describe((String) input.get('sobject'), (String) input.get('search')); }
            when 'create_record' { return save((String) input.get('sobject'), null, (Map<String, Object>) input.get('fields')); }
            when 'update_record' { return save((String) input.get('sobject'), (String) input.get('id'), (Map<String, Object>) input.get('fields')); }
            when 'delete_record' { return remove((String) input.get('id')); }
            when 'run_org_action' { return runAction((String) input.get('action'), (Map<String, Object>) input.get('inputs')); }
            when 'list_files' { return listFiles((String) input.get('recordId')); }
        }
        throw new ToolException('Unknown tool ' + name);
    }

    static Object query(String soql) {
        if (String.isBlank(soql) || !soql.trim().toLowerCase().startsWith('select')) {
            throw new ToolException('Only SELECT queries are allowed');
        }
        String q = soql.trim();
        // Keep it small: the assistant only sees the first rows anyway.
        if (!Pattern.compile('(?i)\\blimit\\s+\\d+').matcher(q).find() && !Pattern.compile('(?i)\\b(count|sum|avg|min|max)\\s*\\(').matcher(q).find()) {
            q += ' LIMIT 200';
        }
        List<SObject> rows = Database.query(q, AccessLevel.USER_MODE);
        List<SObject> shown = new List<SObject>();
        for (Integer i = 0; i < Math.min(rows.size(), MAX_ROWS); i++) {
            shown.add(rows[i]);
        }
        return new Map<String, Object>{ 'totalSize' => rows.size(), 'records' => System.JSON.deserializeUntyped(System.JSON.serialize(shown)) };
    }

    static Object getRecord(String sobjectName, String recordId, List<Object> fields) {
        if (fields == null || fields.isEmpty()) {
            Map<String, Object> rec = CRMAgentsController.recordFor(recordId);
            if (rec == null) {
                throw new ToolException('Record not found, or you do not have access to it');
            }
            return rec;
        }
        List<String> names = new List<String>();
        for (Object f : fields) {
            String n = String.valueOf(f);
            if (!Pattern.matches('[A-Za-z][\\w.]*', n)) {
                throw new ToolException('Bad field name ' + n);
            }
            names.add(n);
        }
        Id rid = (Id) recordId;
        List<SObject> rows = Database.queryWithBinds(
            'SELECT ' + String.join(names, ',') + ' FROM ' + rid.getSObjectType().getDescribe().getName() + ' WHERE Id = :rid LIMIT 1',
            new Map<String, Object>{ 'rid' => rid }, AccessLevel.USER_MODE
        );
        if (rows.isEmpty()) {
            throw new ToolException('Record not found, or you do not have access to it');
        }
        return System.JSON.deserializeUntyped(System.JSON.serialize(rows[0]));
    }

    static Object describe(String sobjectName, String search) {
        Schema.SObjectType t = Schema.getGlobalDescribe().get(sobjectName);
        if (t == null) {
            throw new ToolException('Unknown object ' + sobjectName);
        }
        List<String> words = String.isBlank(search) ? new List<String>() : search.toLowerCase().split('\\s+');
        List<Object> fields = new List<Object>();
        for (Schema.SObjectField f : t.getDescribe().fields.getMap().values()) {
            Schema.DescribeFieldResult d = f.getDescribe();
            if (!d.isAccessible()) {
                continue;
            }
            if (!words.isEmpty()) {
                Boolean hit = false;
                for (String w : words) {
                    hit = hit || d.getName().toLowerCase().contains(w) || d.getLabel().toLowerCase().contains(w);
                }
                if (!hit) {
                    continue;
                }
            }
            Map<String, Object> m = new Map<String, Object>{ 'name' => d.getName(), 'type' => String.valueOf(d.getType()).toLowerCase(), 'updateable' => d.isUpdateable() };
            List<String> refs = new List<String>();
            for (Schema.SObjectType r : d.getReferenceTo()) {
                refs.add(r.getDescribe().getName());
            }
            if (!refs.isEmpty()) {
                m.put('referenceTo', refs);
            }
            List<String> picks = new List<String>();
            for (Schema.PicklistEntry p : d.getPicklistValues()) {
                if (p.isActive()) {
                    picks.add(p.getValue());
                }
            }
            if (!picks.isEmpty()) {
                m.put('picklist', picks);
            }
            fields.add(m);
        }
        return new Map<String, Object>{ 'sobject' => t.getDescribe().getName(), 'fields' => fields };
    }

    static Object save(String sobjectName, String recordId, Map<String, Object> values) {
        Schema.SObjectType t = String.isNotBlank(recordId) ? ((Id) recordId).getSObjectType() : Schema.getGlobalDescribe().get(sobjectName);
        if (t == null) {
            throw new ToolException('Unknown object ' + sobjectName);
        }
        SObject rec = String.isNotBlank(recordId) ? t.newSObject((Id) recordId) : t.newSObject();
        Map<String, Schema.SObjectField> fmap = t.getDescribe().fields.getMap();
        for (String k : (values == null ? new Map<String, Object>() : values).keySet()) {
            Schema.SObjectField f = fmap.get(k);
            if (f == null) {
                throw new ToolException('Unknown field ' + k);
            }
            rec.put(f, coerce(f.getDescribe().getType(), values.get(k)));
        }
        String objectName = t.getDescribe().getName();
        if (String.isNotBlank(recordId)) {
            // What this replaces, so Nimbus can put it back (undo).
            Map<String, Object> before = currentValues(t, (Id) recordId, values == null ? new Set<String>() : values.keySet());
            update as user rec;
            return new Map<String, Object>{ 'success' => true, 'object' => objectName, 'before' => before };
        }
        insert as user rec;
        return new Map<String, Object>{ 'id' => rec.Id, 'success' => true, 'object' => objectName };
    }

    /** The record's current values of these fields (or every readable field when none are given), as this user sees them. */
    @TestVisible
    static Map<String, Object> currentValues(Schema.SObjectType t, Id recordId, Set<String> wanted) {
        Map<String, Schema.SObjectField> fmap = t.getDescribe().fields.getMap();
        List<String> names = new List<String>();
        for (String k : (wanted.isEmpty() ? fmap.keySet() : wanted)) {
            Schema.SObjectField f = fmap.get(k);
            if (f == null) {
                continue;
            }
            Schema.DescribeFieldResult d = f.getDescribe();
            if (!d.isAccessible() || d.getType() == Schema.DisplayType.BASE64 || d.getType() == Schema.DisplayType.ADDRESS || d.getType() == Schema.DisplayType.LOCATION || d.isCalculated()) {
                continue;
            }
            if (wanted.isEmpty() && !d.isUpdateable() && !d.isCreateable()) {
                continue;
            }
            names.add(d.getName());
            if (names.size() >= 150) {
                break;
            }
        }
        Map<String, Object> out = new Map<String, Object>();
        if (names.isEmpty()) {
            return out;
        }
        List<SObject> rows = Database.queryWithBinds(
            'SELECT ' + String.join(names, ',') + ' FROM ' + t.getDescribe().getName() + ' WHERE Id = :rid LIMIT 1',
            new Map<String, Object>{ 'rid' => recordId }, AccessLevel.USER_MODE
        );
        if (rows.isEmpty()) {
            return out;
        }
        for (String n : names) {
            out.put(n, rows[0].get(n));
        }
        return out;
    }

    /** JSON values (mostly strings) into the field's Apex type. */
    @TestVisible
    static Object coerce(Schema.DisplayType t, Object v) {
        if (v == null) {
            return null;
        }
        String s = String.valueOf(v);
        switch on t {
            when DATE { return Date.valueOf(s.left(10)); }
            when DATETIME { return (Datetime) System.JSON.deserialize('"' + s + '"', Datetime.class); }
            when BOOLEAN { return v instanceof Boolean ? v : s.equalsIgnoreCase('true'); }
            when INTEGER { return Integer.valueOf(s); }
            when DOUBLE, CURRENCY, PERCENT { return Decimal.valueOf(s); }
            when else { return s; }
        }
    }

    static Object remove(String recordId) {
        Id rid = (Id) recordId;
        Schema.SObjectType t = rid.getSObjectType();
        // Kept so it can be brought back from the Recycle Bin (undo).
        Map<String, Object> before = currentValues(t, rid, new Set<String>());
        SObject rec = t.newSObject(rid);
        delete as user rec;
        return new Map<String, Object>{ 'success' => true, 'object' => t.getDescribe().getName(), 'before' => before };
    }

    /** Files on a record that this user can see. Nimbus reads only these (by their version Id). */
    static Object listFiles(String recordId) {
        Id rid = (Id) recordId;
        List<Object> files = new List<Object>();
        for (ContentDocumentLink l : [
            SELECT ContentDocumentId, ContentDocument.Title, ContentDocument.FileExtension, ContentDocument.ContentSize, ContentDocument.LatestPublishedVersionId
            FROM ContentDocumentLink WHERE LinkedEntityId = :rid WITH USER_MODE ORDER BY ContentDocument.LastModifiedDate DESC LIMIT 50
        ]) {
            files.add(new Map<String, Object>{
                'title' => l.ContentDocument.Title, 'extension' => l.ContentDocument.FileExtension,
                'size' => l.ContentDocument.ContentSize, 'versionId' => l.ContentDocument.LatestPublishedVersionId
            });
        }
        return new Map<String, Object>{ 'files' => files };
    }

    static Object runAction(String key, Map<String, Object> inputs) {
        List<String> parts = key == null ? new List<String>() : key.split(':', 2);
        if (parts.size() != 2) {
            throw new ToolException('Use a key like flow:Name, apex:Name or standard:emailSimple');
        }
        Invocable.Action a = parts[0] == 'standard' ? Invocable.Action.createStandardAction(parts[1]) : Invocable.Action.createCustomAction(parts[0], parts[1]);
        for (String k : (inputs == null ? new Map<String, Object>() : inputs).keySet()) {
            a.setInvocationParameter(k, inputs.get(k));
        }
        List<Invocable.Action.Result> res = a.invoke();
        if (res.isEmpty() || !res[0].isSuccess()) {
            String msg = 'The action failed';
            if (!res.isEmpty() && res[0].getErrors() != null && !res[0].getErrors().isEmpty()) {
                msg = res[0].getErrors()[0].getMessage();
            }
            throw new ToolException(msg);
        }
        return new Map<String, Object>{ 'success' => true, 'outputs' => res[0].getOutputParameters() };
    }
}

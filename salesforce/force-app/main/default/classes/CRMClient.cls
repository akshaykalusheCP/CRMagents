/**
 * Signed HTTP client for the CRMagents platform. Every request carries the org id, a timestamp
 * and an HMAC-SHA256 signature made with the per-org secret stored in CRMagents_Config__c.
 */
public with sharing class CRMClient {
    public class CRMException extends Exception {}

    public static System.HttpResponse call(String method, String pathAndQuery, String body) {
        CRMagents_Config__c c = CRMagents_Config__c.getOrgDefaults();
        if (c == null || String.isBlank(c.Base_Url__c) || String.isBlank(c.Signing_Secret__c)) {
            throw new CRMException('CRMagents is not connected for this org. Reconnect it in the CRMagents app.');
        }
        String payloadBody = body == null ? '' : body;
        String ts = String.valueOf(Datetime.now().getTime());
        String signed = ts + '.' + method.toUpperCase() + '.' + pathAndQuery + '.' + payloadBody;
        Blob mac = System.Crypto.generateMac('HmacSHA256', Blob.valueOf(signed), Blob.valueOf(c.Signing_Secret__c));

        System.HttpRequest req = new System.HttpRequest();
        req.setEndpoint(c.Base_Url__c.removeEnd('/') + pathAndQuery);
        req.setMethod(method);
        req.setTimeout(120000);
        req.setHeader('Content-Type', 'application/json');
        req.setHeader('X-CRM-Org', System.UserInfo.getOrganizationId());
        req.setHeader('X-CRM-Timestamp', ts);
        req.setHeader('X-CRM-Signature', System.EncodingUtil.convertToHex(mac));
        if (body != null) {
            req.setBody(body);
        }
        return new System.Http().send(req);
    }

    /** Returns the response body, or throws with the platform's error message. */
    public static String okBody(System.HttpResponse res) {
        if (res.getStatusCode() >= 200 && res.getStatusCode() < 300) {
            return res.getBody();
        }
        String msg = 'CRMagents returned HTTP ' + res.getStatusCode();
        try {
            Map<String, Object> m = (Map<String, Object>) System.JSON.deserializeUntyped(res.getBody());
            if (m.get('error') != null) {
                msg = String.valueOf(m.get('error'));
            }
        } catch (Exception e) {
            // keep the generic message
        }
        throw new CRMException(msg);
    }
}

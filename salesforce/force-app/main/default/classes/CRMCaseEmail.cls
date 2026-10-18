/**
 * Replies to a customer's email on a case from inside Salesforce: in the same thread (In-Reply-To the customer's
 * message), from the support address they wrote to when there is an org-wide address for it, and logged on the
 * case. Agents call it as a Flow/REST action; the Suggestions card calls it when a person clicks Send.
 */
public with sharing class CRMCaseEmail {
    public class Request {
        @InvocableVariable(label='Case Id' required=true) public String caseId;
        @InvocableVariable(label='To') public String toAddress;
        @InvocableVariable(label='Subject') public String subject;
        @InvocableVariable(label='Body (HTML)' required=true) public String htmlBody;
        @InvocableVariable(label='Replying to EmailMessage Id') public String inReplyToId;
    }
    public class Result {
        @InvocableVariable(label='Sent') public Boolean sent;
        @InvocableVariable(label='Error') public String error;
    }

    @InvocableMethod(label='Reply to case email' description='Sends a threaded email reply on a case and logs it' category='Nimbus')
    public static List<Result> sendReplies(List<Request> requests) {
        List<Result> out = new List<Result>();
        for (Request r : requests) {
            Result res = new Result();
            try {
                send(r.caseId, r.toAddress, r.subject, r.htmlBody, r.inReplyToId);
                res.sent = true;
            } catch (Exception e) {
                res.sent = false;
                res.error = e.getMessage();
            }
            out.add(res);
        }
        return out;
    }

    /** The latest email the customer sent on the case (what the reply answers). */
    public static EmailMessage lastIncoming(Id caseId) {
        List<EmailMessage> m = [
            SELECT Id, FromAddress, ToAddress, Subject, MessageIdentifier
            FROM EmailMessage WHERE ParentId = :caseId AND Incoming = true ORDER BY MessageDate DESC LIMIT 1
        ];
        return m.isEmpty() ? null : m[0];
    }

    public static void send(String caseId, String toAddress, String subject, String htmlBody, String inReplyToId) {
        Id cid = (Id) caseId;
        EmailMessage original = null;
        if (String.isNotBlank(inReplyToId)) {
            List<EmailMessage> m = [SELECT Id, FromAddress, ToAddress, Subject, MessageIdentifier FROM EmailMessage WHERE Id = :inReplyToId AND ParentId = :cid LIMIT 1];
            original = m.isEmpty() ? null : m[0];
        }
        if (original == null) {
            original = lastIncoming(cid);
        }
        String to = String.isNotBlank(toAddress) ? toAddress : (original != null ? original.FromAddress : null);
        if (String.isBlank(to)) {
            Case c = [SELECT SuppliedEmail, ContactEmail FROM Case WHERE Id = :cid];
            to = String.isNotBlank(c.ContactEmail) ? c.ContactEmail : c.SuppliedEmail;
        }
        if (String.isBlank(to)) {
            throw new CRMClient.CRMException('No email address to reply to on this case');
        }
        Messaging.SingleEmailMessage mail = new Messaging.SingleEmailMessage();
        mail.setToAddresses(new List<String>{ to });
        String subj = String.isNotBlank(subject) ? subject : (original != null && String.isNotBlank(original.Subject) ? original.Subject : 'Your case');
        mail.setSubject(subj.startsWithIgnoreCase('Re:') ? subj : 'Re: ' + subj);
        mail.setHtmlBody(htmlBody);
        mail.setWhatId(cid);
        mail.setSaveAsActivity(true);
        mail.setUseSignature(false);
        if (original != null && String.isNotBlank(original.MessageIdentifier)) {
            // Header-based threading: the customer's mail client and Email-to-Case keep it in one conversation.
            mail.setInReplyTo(original.MessageIdentifier);
            mail.setReferences(original.MessageIdentifier);
        }
        // Reply from the support address the customer wrote to, when it is set up as an org-wide address.
        if (original != null && String.isNotBlank(original.ToAddress)) {
            List<String> addrs = new List<String>();
            for (String a : original.ToAddress.split('[;,]')) {
                addrs.add(a.trim().toLowerCase());
            }
            List<OrgWideEmailAddress> ow = [SELECT Id FROM OrgWideEmailAddress WHERE Address IN :addrs LIMIT 1];
            if (!ow.isEmpty()) {
                mail.setOrgWideEmailAddressId(ow[0].Id);
            }
        }
        Messaging.SendEmailResult[] r = Messaging.sendEmail(new List<Messaging.SingleEmailMessage>{ mail });
        if (!r[0].isSuccess()) {
            throw new CRMClient.CRMException(r[0].getErrors()[0].getMessage());
        }
    }
}

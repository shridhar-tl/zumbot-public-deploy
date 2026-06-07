export function onBeforeGenerateResponse(req) {
    let issueBody = req.issueDetails.body;

    // Remove unnecessary content on top of the issue body
    const cleanupStartIndex = issueBody.indexOf("### How do you use Jira Assistant?");
    if (~cleanupStartIndex) {
        issueBody = issueBody.substring(cleanupStartIndex);
    }

    // Remove unnecessary content on bottom of the issue body
    const cleanupEndIndex = issueBody.indexOf("### Checklist before you submit");
    if (~cleanupEndIndex) {
        issueBody = issueBody.substring(0, cleanupEndIndex);
    }

    // Mutate the body content
    req.issueDetails.body = issueBody.trim();

    // Remove unnecessary disclaimer content from comments
    req.comments = req.comments.map(c => {
        const index = c.body.indexOf(`---\n**Disclaimer**`);
        if (~index) {
            c.body = c.body.substring(0, index).trim();
        }

        return c;
    });

    return req;
}
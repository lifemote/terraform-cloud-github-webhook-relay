// Load the AWS SDK for Node.js
const AWS = require("aws-sdk");
const https = require("https");

// Create DynamoDB service object
const ddb = new AWS.DynamoDB({apiVersion: "2012-08-10"});
const repositories = JSON.parse(process.env.GITHUB_REPOSITORIES);

const target = "api.github.com";


function asyncRequest(options, payload = "") {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                resolve({
                    "body": Buffer.concat(chunks).toString(),
                    "statusCode": res.statusCode,
                    "headers": res.headers
                });
            });
        });
        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}

exports.handler = async (event, context) => {
    let user = event.pathParameters.user;
    let repo = event.pathParameters.repo;

    const options = {
        hostname: target,
        port: 443,
        path: event.path,
        method: event.httpMethod,
        headers: event.headers
    };
    options.headers.Host = target;
    // disable compression for easier response handling
    delete options.headers["accept-encoding"];

    // relay get request to GitHub to receive current webhooks list
    const response = await asyncRequest(options);
    if (response.statusCode == 200 && user == process.env.GITHUB_OWNER && repositories.includes(repo)) {
        let responseBody = JSON.parse(response.body);

        // we should have our relaying webhook registered on GitHub at this stage
        if (responseBody.length > 0) {

            let params = {
                TableName: "tf_webhooks",
                ExpressionAttributeValues: {
                    ":repo" : {S: `${user}/${repo}`}
                },
                KeyConditionExpression: "repo = :repo"
            };

            try {
                // query DynamoDB table to get terraform webhooks that we handle and add fake JSONs of them to the response
                // so that terraform cloud thinks the webhooks exists on GitHub and calls DELETE endpoint when necessary
                const data = await ddb.query(params).promise();
                data.Items.forEach(function(element, index, array) {
                    let item = { ... responseBody[0] };

                    item.id = element.id.N;
                    // shallow copy, need to create a new config object not to overwrite real webhook data
                    item.config = {
                        content_type: "json",
                        insecure_ssl: "0",
                        secret: "********",
                        url: element.url.S
                    };
                    item.created_at = element.date.S;
                    item.updated_at = element.date.S;
                    item.url = `https://api.github.com/repos/${element.repo.S}/hooks/${element.id.N}`;
                    item.test_url = `https://api.github.com/repos/${element.repo.S}/hooks/${element.id.N}/test`;
                    item.ping_url = `https://api.github.com/repos/${element.repo.S}/hooks/${element.id.N}/pings`;
                    item.deliveries_url = `https://api.github.com/repos/${element.repo.S}/hooks/${element.id.N}/deliveries`;

                    responseBody.push(item);
                });
                response.body = JSON.stringify(responseBody, null, 2);
            } catch (err) {
                console.log("Error", err);
                response.body = JSON.stringify({
                    "error": `Could not list webhooks: ${err}`
                }, null, 2);
                response.statusCode = 500;
            }
        }
    }

    return response;
};

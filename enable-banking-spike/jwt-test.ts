import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import 'dotenv/config';
import http from "node:http";

function waitForCallback(): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const fullURL = new URL(req.url as string, "http://localhost:3000");

      const code = fullURL.searchParams.get("code");
      const state = fullURL.searchParams.get("state");

      res.end("Success! You can close this tab");

      if (code && state) {
        server.close();
        resolve({ code, state });
      }
    });

    server.listen(3000, () => {
      console.log("Server listening from port 3000");
    });
  });
}

//read the file
const privateKey = fs.readFileSync(process.env.ENABLE_BANKING_PRIVATE_KEY_PATH as string);

const token = jwt.sign(
    {
        iss: 'enablebanking.com',
        aud: 'api.enablebanking.com',
    },
    privateKey,
    {
        algorithm: 'RS256',
        keyid: process.env.ENABLE_BANKING_APP_ID as string,
        expiresIn: '1h', //stay under 24h max
    }
)

const baseHeader = {
    Authorization: `Bearer ${token}`,
};

//fetch the list available in the UK
const aspspsResponse = await fetch('https://api.enablebanking.com/aspsps?country=FI', {
    headers: baseHeader,
});

const aspspsData = await aspspsResponse.json();

console.log('Available ASPS:');
console.log(JSON.stringify(aspspsData,null, 2));

// Start the authorization process
const validUntil = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000); // 10 days ahead

const startAuthorizationBody = { //what we send 
    access: {
        valid_until : validUntil.toISOString(),
    },
    aspsp: {
        name: 'Nordea',  // TODO: replace with a real name from your ASPSPs list
        country: 'FI',
    },
    state: crypto.randomUUID(), //ensure two items does not share the same id
    redirect_url: 'http://localhost:3000/callback', //redirect
    psu_type: 'personal',
}

console.log('State sent:', startAuthorizationBody.state);

 //what we get for the response
const startAuthorizationResponse = await fetch('https://api.enablebanking.com/auth', 
    {
        method: 'POST',
        headers: 
        {
            ...baseHeader,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(startAuthorizationBody),
    }
);

const startAuthorizationData = await startAuthorizationResponse.json();

console.log('Start Authorizing Process...');
console.log(JSON.stringify(startAuthorizationData,null,2));

//pause here and wait for the user to approve in browser
console.log('\n>>> Open this URL in your browser to approve access:');
console.log(startAuthorizationData.url);
console.log('\nWaiting for redirect...\n');

const { code, state } = await waitForCallback();

console.log(`Callback received. Code: ${code} State: ${state}`);

//do CSRF check
if(state != startAuthorizationBody.state){
    throw new Error(
        `State mismatch! Sent ${startAuthorizationBody.state}, received ${state}. Aborting — this could be a spoofed request.`
    );
}

//exchange code for the session token
const createSessionResponse =  await fetch('https://api.enablebanking.com/sessions',
    {
        method: 'POST',
        headers:{
            ...baseHeader,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ code }),
    }
);

console.log("Session status code:", createSessionResponse.status);
const sessionData = await createSessionResponse.text();
console.log('Session response:', sessionData);






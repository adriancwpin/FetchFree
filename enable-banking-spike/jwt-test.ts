import fs from 'node:fs';
import 'dotenv/config';

//read the file
const data = fs.readFileSync(process.env.ENABLE_BANKING_PRIVATE_KEY_PATH as string);

console.log(data);
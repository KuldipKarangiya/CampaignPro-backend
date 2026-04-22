require('dotenv').config();
const db = require('./src/config/db');
const Contact = require('./src/models/Contact');

async function run() {
  await db();
  const search = 'Madd';
  const searchRegex = new RegExp(search, 'i');
  
  const query = {
    $or: [
      { name: { $regex: searchRegex } },
      { email: { $regex: searchRegex } },
      { phone: { $regex: searchRegex } }
    ]
  };

  const count = await Contact.countDocuments(query);
  console.log('Count for Madd:', count);
  
  const docs = await Contact.find(query).limit(5);
  console.log('Docs:', docs);
  
  process.exit(0);
}

run();

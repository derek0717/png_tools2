
const express = require('express');
const path = require('path');
const routes = require('./routes/routes');

const app = express();
app.use(express.json());
app.use('/api', routes);
app.use(express.static(path.join(__dirname,'../client')));

app.listen(3000,()=>console.log('http://localhost:3000'));

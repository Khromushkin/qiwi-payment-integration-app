const express = require('express');
const path = require('path');
const mongodb = require('mongodb');
const moment = require('moment');
const fetch = require('node-fetch');
const jsonParser = require('body-parser').json();
const QiwiBillPaymentsAPI = require('@qiwi/bill-payments-node-js-sdk');

const url = process.env.HEROKU_URL;
const PORT = process.env.PORT || 5000;
const qiwiSecretKey = process.env.QIWI_SECRET_KEY;
const qiwiApi = new QiwiBillPaymentsAPI(process.env.QIWI_SECRET_KEY);
const qiwiPublicKey = process.env.QIWI_PUBLIC_KEY;
const qiwiEdgeToken = process.env.QIWI_EDGE_TOKEN;
const mongoUrl = process.env.MONGODB_URI;
const ratesUrl = 'https://edge.qiwi.com/sinap/crossRates';

async function startApp() {
    console.log('start app begin')
    const mongoConnection = await mongodb.MongoClient.connect(mongoUrl, {useUnifiedTopology: true});
    const customersDb = mongoConnection.db();
    const customersCollection = customersDb.collection('customers');
    console.log('db connected');
    express()
        .use(express.static(path.join(__dirname, 'public')))
        .use(jsonParser)
        .set('views', path.join(__dirname, 'views'))
        .set('view engine', 'ejs')
        .get('/', (req, res) => res.render('pages/index'))
        .get('/success', (req, res) => res.render('pages/success'))
        .get('/healthcheck', (req, res) => res.send('ok'))
        .post('/checkout', checkoutHandler)
        .post('/qiwi-notification', qiwiNotificationHandler)
        .listen(PORT, () => console.log(`Listening on ${PORT}`));

    async function checkoutHandler(req, res) {
        const invoiceParams = req.body;
        const billId = qiwiApi.generateId();
        const invoiceTemplate = await customersCollection.insertOne({_id: billId, email: invoiceParams.email});

        const qiwiBill = await qiwiApi.createBill(billId, {
            amount: await convertUsdToRub(invoiceParams.amount),
            currency: 'RUB',
            successUrl: url + 'success',
            customFields: {
                themeCode: 'n-khromushkin'
            },
            expirationDateTime: moment().add(1, 'day').toISOString(true)
        })
        await customersCollection.updateOne({_id: billId}, {$set: qiwiBill}, {upsert: true});
        // const res = await customersCollection.findOne({_id: mongodb.ObjectId(insereRes.insertedId.toString())});

        res.send(JSON.stringify(qiwiBill));
    }


    async function qiwiNotificationHandler(req, res) {
        if (!qiwiApi.checkNotificationSignature(req.headers['x-api-signature-sha256'], req.body, qiwiSecretKey)) {
            throw new Error('WRONG_SIGNATURE')
        }
        console.log('got bill notification', req.body.bill.billId);
        await customersCollection.updateOne({_id: req.body.bill.billId}, {$set: req.body.bill}, {upsert: true});
        return res.status(204).send();
    }

    async function convertUsdToRub(usdAmount) {
        const currencyRateResponse = await fetch(ratesUrl, {
            headers: {
                'Authorization': 'Bearer ' + qiwiEdgeToken
            },
        });
        const rates = await currencyRateResponse.json();
        return usdAmount / rates.result.find(rate => (rate.from === '840' && rate.to === '643')).rate;
    }
}


startApp();

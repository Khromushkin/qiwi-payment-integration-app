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
const pauoutCardUrl = 'https://edge.qiwi.com/sinap/api/v2/terms/21013/payments';
const pauoutWalletUrl = 'https://edge.qiwi.com/sinap/api/v2/terms/99/payments';
const comissionCardUrl = 'https://edge.qiwi.com/sinap/providers/21013/onlineCommission';
const comissionWalletUrl = 'https://edge.qiwi.com/sinap/providers/99/onlineCommission';
const payoutCardPan = process.env.PAYOUT_CARD_PAN;
const payoutWallet = process.env.PAYOUT_WALLET;

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

    await payout('7907e7f5-c55f-44e5-8622-3f3b18ae1ceb');

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
        res.send(JSON.stringify(qiwiBill));
    }


    async function qiwiNotificationHandler(req, res) {
        if (!qiwiApi.checkNotificationSignature(req.headers['x-api-signature-sha256'], req.body, qiwiSecretKey)) {
            throw new Error('WRONG_SIGNATURE')
        }
        console.log('got bill notification', req.body.bill);
        await customersCollection.updateOne({_id: req.body.bill.billId}, {$set: req.body.bill}, {upsert: true});
        await payout(req.body.bill.billId);
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

    async function payout(billId) {
        const storedBill = await customersCollection.findOne({_id: billId});
        if (!storedBill)
            return;
        if (storedBill.status.value !== 'PAID') {
            return;
        }
        if (storedBill.payoutResult && storedBill.payoutResult.transaction.state.code === 'Accepted') {
            return;
        }
        console.log('start payout', billId);
        const comissionResponse = await fetch(comissionWalletUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': 'Bearer ' + qiwiEdgeToken
            },
            body: JSON.stringify({
                account: payoutWallet,
                paymentMethod: {
                    type: 'Account',
                    accountId: '643'
                },
                purchaseTotals: {
                    total: {
                        amount: Number(storedBill.amount.value),
                        currency: '643'
                    }
                }
            })
        });
        const comission = await comissionResponse.json();
        console.log('got commission for amount', storedBill.amount.value, comission.qwCommission.amount);
        const payoutAmount = Number(storedBill.amount.value) - comission.qwCommission.amount;
        const payoutResponse = await fetch(pauoutWalletUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': 'Bearer ' + qiwiEdgeToken
            },
            body: JSON.stringify({
                id: (moment().unix() * 1000).toString(),
                account: payoutWallet,
                paymentMethod: {
                    type: 'Account',
                    accountId: '643'
                },
                sum: {
                    amount: payoutAmount,
                    currency: '643'
                },
                fields: {
                    account: '+' + payoutWallet
                }
            })
        });
        const payoutResult = await payoutResponse.json();
        console.log('got payout result for bill', billId, payoutResult.transaction.state.code);
        if (payoutResult && payoutResult.transaction.state.code === 'Accepted') {
            storedBill.payoutResult = payoutResult;
            await customersCollection.updateOne({_id: billId}, {$set: storedBill}, {upsert: true});
            console.log('bill payout completed', billId, payoutResult.transaction);
        }
    }
}


startApp();

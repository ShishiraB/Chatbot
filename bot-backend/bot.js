const express = require('express');
const axios = require('axios')
const bodyParser = require('body-parser');
const cors = require('cors');
const { default: rateLimit } = require('express-rate-limit');
require('dotenv').config();
const app = express();
const mongoClient = require('mongodb').MongoClient;

const waToken = process.env.WATOKEN;
const verify_token = process.env.VERIFY_TOKEN;
const mongo_Uri = process.env.MONGO_URI;
const client = new mongoClient(mongo_Uri, {useNewUrlParser: true, useUnifiedTopology: true});
let collection, collection1;
let issueNumber = [];

function initialize() {
    app.use(express.static('pages'));
    app.use(bodyParser.urlencoded({extended: false}));
    app.use(bodyParser.json());
    app.use(cors());
    //using api limiter
    const limiter = rateLimit({
        windowMs: 1 * 60 * 1000, //1 minute window
        max: process.env.API_LIMITER, //start blocking after 3 requests
        message:{
            status: 429,
            message: "Too Many Requests"
        }
    })

    client.connect(err => {
        if(err) {
            console.log(err);
            client.close();
        } else {
            collection = client.db("Whatsapp").collection("Whatsapp_Messages"); //mongo db collection
            collection1 = client.db("Whatsapp").collection("Whatsapp_Agent_Replies");//mongo db collection for agent replies
            console.log('Connected to Mongo DB')
            app.get('/chatbot/validation',function(req,res) {
                handelValidation(req, res);
            });
        
            app.post('/chatbot/validation', function(req, res) {
                handelGetUserInput(req, res);
                res.sendStatus(200); //sending the status to whatsapp (facebook api)
            })

            app.post('/chatbot/getMessage', limiter, verify, function(req, res) {
                handelGetAllMessages(req.body, res); //secured api
            })

            app.get('/chatbot/getPhoneNumbers', limiter, verify, function(req, res) {
                handelGetAllNumbers(req, res); //secured api
            })
            
            app.get('/chatbot/getCurrentPhoneNumber', limiter, verify, function(req, res) {
                handelGetCurrentNumber(req,res); //secured api
            })
        }
    })
}

app.listen(3400,function(){
    console.log("Listening on port 3400");
    initialize();
});

async function handelValidation(req, res) { //function to get the creadentials verified by the facebook servers
    let mode = req.query["hub.mode"];
    let token = req.query["hub.verify_token"];
    let challenge = req.query["hub.challenge"];

    // Check if a token and mode were sent
    if (mode && token) {
        // Check the mode and token sent are correct
        if (mode === "subscribe" && token === verify_token) {
        // Respond with 200 OK and challenge token from the request
        console.log("WEBHOOK_VERIFIED");
        res.status(200).send(challenge);
        } else {
        // Responds with '403 Forbidden' if verify tokens do not match
        res.sendStatus(403);
        }
    }
}

async function handelGetUserInput(req, res) { //handelling the user input i.e.: message coming from whatsapp from customers
    let body = req.body;
    
    //#region test on localhost
    // console.log(body)
    // let data = {
    //     'message' : body.message
    // }

    // let helpMessage = {
    //     'message' : "/help"
    // }
    // if(body.message === 'hi' || body.message === 'Hi') {
    //     sendToBot(data);
    //     await sleep(2000)
    //     sendToBot(helpMessage)
    // }
    //#endregion test on localhost

    //#region ActualMessage
    if(body.object) {
        let phone_number_id = '';
        let from = '';
        let msg_body_switcher = '';
        let msg_body = '';
        let type = '';
        let data = {};
        const idPattern = /Id:/;
        if(body.entry && body.entry[0].changes && body.entry[0].changes[0] && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
            phone_number_id = req.body.entry[0].changes[0].value.metadata.phone_number_id;
            type = req.body.entry[0].changes[0].value.messages[0].type;
            from = req.body.entry[0].changes[0].value.messages[0].from;
            let Usermessage = req.body.entry[0].changes[0].value.messages[0].text.body;
            let Botmessage = "";
            msg_body_switcher = req.body.entry[0].changes[0].value.messages[0].text.body;
            let time = getCurrentTimestamp();// function call to get the timestamp for the incoming message
            sendToDB(from, Usermessage, Botmessage,time); //function to store message in database
            let removed = removeFromArray(from); //function call to check if the number has been removed from the array
            if(removed) {
                sendTemplate(phone_number_id, from, 'issue_notified'); //if the number has been removed then send the issue notified template to user
                return
            }
            msg_body = switcher(msg_body_switcher); //function to get the message text by switching from use input number
            if(idPattern.test(msg_body)) { //checking if the user has typed the above given pattern 
                raiseTicket(msg_body, phone_number_id, from); //function call to raise the ticket
            } else if(msg_body === '0') { //checking if user typed 0 in the message
                sendTemplate(phone_number_id, from, 'bot_menu_1'); //function call to send the bot_menu_1 template based on user input i.e.: 0
            } else if(msg_body.toLowerCase() === 'other') { //checking if user typed other in the message
                sendTemplate(phone_number_id, from, 'default_issue_message_with_order_id'); // function call to send the issue template cz user pressed other (user wasnt satisfied by the issue menu)
                issueNumber.push(from); //pushing the number to array as the user was not satisfied by the menu options
                storeNumberInDB(from); //storing the nmber in db so that it can be viewed on frontend (custom frontend)
            } else {
                data.message = msg_body;
                //sending incoming the message from whatsapp to the chatbot
                await axios({
                    method: 'post',
                    url : process.env.URL,
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    data : data.message
                }).then(async (result) => { //getting the computed result from chatbot stored in the result variable
                    if(result.data.result) {
                        let Botmessage = result.data.result;
                        let Usermessage = "";
                        let time = getCurrentTimestamp();
                        sendToDB(from, Usermessage, Botmessage, time); //function call to store the received bot response in db
                        await sendToWhatsApp(result.data.result, phone_number_id, from);// function call to send the bot response to whatsapp
                        //#region displaying the options
                        if(msg_body === 'hi' || msg_body === 'Hi') {
                            await sendTemplate(phone_number_id, from, 'bot_menu_1'); //if user sent hi then sending him the menu options
                        }
                        //#endregion displaying the options
                    }
                }).catch((err) => { //if any error catching it and printing it in the terminal
                    console.log(err);
                })
            }
        }
        return //sending the status to 200 to whatsapp (facebook api)
    } else {
        res.sendStatus(404); //sending the failed status code to whatapp (facebook api)
    }
    //#endregion ActualMessage
}

function switcher(messages) {
    switch(messages) {
        case '1':
            return 'About Flocco';
            break;
        case '2':
            return 'Order';
            break;
        case '3':
            return 'Payment';
            break;
        case '4':
            return 'Feedback'
            break;
        case '5':
            return 'Discount'
            break;
        case '6':
            return 'Account'
            break;
        case '7':
            return 'App'
            break;
        default:
            return messages;
            break;
    }
}

function sendToDB (from, Usermessage, Botmessage, time) { //storing in db
    let inputData = {
        "Phone_Number" : from,
        "User_Messages": Usermessage,
        "Bot_Messages": Botmessage,
        "DateTime": time
    }
    collection.insertOne(inputData).then((result) => {
        console.log(result);
    }).catch((err) => {
        console.log(err);
    })
}

function storeNumberInDB (from) {
    let inputData = {
        "Phone_Number": from,
        "Ticket_Id": "",
        "Issue_Status": "Open",
    }
    collection.insertOne(inputData).then((result) => {
        console.log(result);
    }).catch((err) => {
        console.log(err);
    })
}

function getCurrentTimestamp() { //getting the message incommming and outgoing time from this server
    return new Date().getTime();
}

function handelGetAllMessages(number, res) { //api call to get all the messages stored in db
    let query = {
        "Phone_Number" : number.phone,
    }
    collection.find(query, {projection:{_id:0}}).sort({_id:-1}).toArray().then((result) => {
        if(result.length > 0) {
            res.json({"response_desc":"Success","response_data":result,"response_code":"0"});
        } else {
            res.json({"response_desc":"Failure","response_data":{},"response_code":"1"});
        }
    }).catch((err) => {
        res.json({"response_desc":"Internal Server Error","response_data":err,"response_code":"500"});
    })
}

function handelGetAllNumbers(req, res) { // api call to get all the phonenumbers in db
    collection.distinct("Phone_Number").then((result) => {
        if(result.length > 0) {
            res.json({"response_desc":"Success","response_data":result,"response_code":"0"});
        } else {
            res.json({"response_desc":"Failure","response_data":{},"response_code":"1"});
        }
    }).catch((err) => {
        res.json({"response_desc":"Internal Server Error","response_data":err,"response_code":"500"});
    })
}

function handelGetCurrentNumber(req, res) {
    collection.find("Phone_Number").then((result) => {
        if(result.length > 0) {
            res.json({"response_desc":"Success","response_data":result,"response_code":"0"});
        } else {
            res.json({"response_desc":"Failure","response_data":{},"response_code":"1"});
        }
    }).catch((err) => {
        res.json({"response_desc":"Internal Server Error","reponse_data":err,"response_code":"500"});
    })
}

function raiseTicket(id, phone_number_id, from) { //function to raise the ticket
    let ID = id.split(':')[1] //splitting the incomming message i.e.:Order_Id:<order_id> to just <order id>
    let tktMessage = "Ticket for the Order : "+ID+" has been raised\nThe company will contact you within 24 hours\nThank you";
    sendToWhatsApp(tktMessage, phone_number_id, from); //function call to send the message to user using whatsapp
    let time = getCurrentTimestamp();
    sendToDB(from, Usermessage, tktMessage, time);// function call to store the result in db
}

async function sendToWhatsApp(data, phone_number_id, from) { //sendin to messages whatsapp 
    await axios({
        method: 'post',
        url : process.env.USER_URL + phone_number_id + "/messages?access_token=" + waToken,
        headers: {
            'Content-Type': 'application/json'
        },
        data : {
            messaging_product: "whatsapp",
            to: from,
            text: { body: data },
        }
    }).catch(err => {
        console.log(err.response);
    })
}

async function sendTemplate(phone_number_id, from, template_Name) { //sending the message template to whatsapp
    await axios({
        method: 'post',
        url : process.env.USER_URL + phone_number_id + "/messages",
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer '+waToken
        },
        data: {
            messaging_product: "whatsapp",
            to: from,
            type: "template",
            template: {
                name: template_Name,
                language: {
                    code: "en"
                }
            }
        }
    }).catch(err => {
        console.log(err);
    })
}

function verify (req, res, next) { //verifying the request coming from hubble only basically api security
    let address = process.env.HUBBLE.split(",");
    let ip = req.headers["x-real-ip"];

    if(address.includes(ip)) {
        next()
    } else {
        res.setHeader('content-type', 'Application/json');
        res.statusCode = 403;
        res.json({ "response_desc": "Unauthorized" });
    }
}

function removeFromArray(number) { //removing the number from array whose issue has been notified
    for(let i=0;i<issueNumber.length;i++){
        if(number === issueNumber[i]){
            issueNumber.pop(number);
            return 1;
        } else {
            return 0;
        }
    }
}
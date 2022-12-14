'use strict'
/** @module controllers/auth */

/**
 * @requires config - Require config wich includes main environment configuration
 * @requires bcrypt - Require bcrypt module wich decypt / encrypt in 2 ways 
 * @requires moment - Require moment library
 * @requires User - Require User model to connect with database
 * @requires UserPassword - Require UserPassword model to connect with database
 * @requires jwt - Require jwt service to handle JWT manipulation
 * @requires mailing - Require mailing service to handle mailing sending
 */
const config = require('config');
const bcrypt = require('bcrypt');
const moment = require('moment');
var User = require('../models/user');
var UserPassword = require('../models/user_password');
const jwt = require('../services/jwt');
const mailing = require('../services/mailing');


/**
 * @description Controller function that handles user login authorization
 *
 * @typedef {Object} requestBody
 * @property {number} req.body.email - User email information
 * @property {string} req.body.password - User passsword information
 * 
 * @param {Express.Request<{},{},requestBody>} req
 * @param {Express.Response} res
 * @param {Function} next
 * 
 * @typedef {Object} responseData
 * @property {Array} tenants - Assigned user tenants information
 * @property {Object} user - Current user info
 * 
 * @param {Function(responseData)} data - res.send
 * 
 * @returns {void}
 */
exports.doLogin = function(req, res, next) {
    /** params - Copy current request body to a local variable  */
    let params = req.body;

    /** auth_type - Define initial authentication type, currently only email password supported  */
    let auth_type = '';
    if (params.email && params.password) {
        auth_type = 'email'
    }

    /** Do something different for each case of authentication type defined */
    switch (auth_type) {
        /** Functionality for email authentication type */
        case 'email':
            /**
             * Find user by email
             * Explicitly expose secret_key and password to compare it later
             * */
            User.findOne({ email: params.email }).select('+secret_key +password').exec((err, user) => {
                /** If error or no user found, then pass error to next handler */
                if (err || !user || !user.password) {
                    next({ status: 200, message: 'Error login 2.', error: user });
                } else {
                    /** If password don't match, then pass error to next handler */
                    if ( !bcrypt.compareSync( user.secret_key+'-'+params.password, user.password) ) {
                        next({ status: 200, message: 'Email o contrase??a incorrectos.', error: 'Email o contrase??a incorrectos.' });
                    } else {
                        /** Into this code, user should exists, define population object */
                        var populate = [
                            { path: '_tenants._tenant', select: 'name img color' },
                            { path: '_tenants._role', populate: { path: 'permissions', select: 'slug -_id' }, select: '-_id -_tenant' }
                        ];
                        /** Then populate with tenants and permissions */
                        user.populate(populate, function(err) {
                            /** User should be a valid populated object */
                            if (!err) {
                                /** tmp_user - Create a local copy user information */
                                let tmp_user = user.toObject();
                                /** Remove sensible data from user */
                                delete tmp_user._tenants;
                                delete tmp_user.device_tokens;
                                delete tmp_user.secret_key;
                                
                                res.send({
                                    tenants: user._tenants.toObject().map( tn => {
                                        if (!tn._role) {
                                            tn._role = {};
                                        }
                                        if (!tn._role.permissions) {
                                            tn._role.permissions = [];
                                        }
                                        tn._role.permissions = tn._role.permissions.map( p => p.slug )
                                        tn.token = jwt.createToken({
                                            _user: tmp_user._id,
                                            _tenant: tn._tenant._id,
                                            key: user.secret_key
                                        });
                                        return tn;
                                    }).filter( tn => tn.active ),
                                    user: tmp_user,
                                });
    
                            } else {
                                /** an error occurred when trying to populate role and tenants */
                                next({ status: 200, message: 'Error retriving user.' });
                            }
                        })
                    }
                }
            });
            break;
        default:
            /** auth_type wasn't found */
            next({ status: 200, message: 'Authentication data required.', type: auth_type });
    }


}



/**
 * @description Controller function that handles user login authorization
 *
 * @typedef {Object} requestBody
 * @property {number} req.body.token - User token information
 * 
 * @param {Express.Request<{},{},requestBody>} req
 * @param {Express.Response} res
 * @param {Function} next
 * 
 * @typedef {Object} responseData
 * 
 * @param {Function(responseData)} data - res.send
 * 
 * @returns {void}
 */
exports.validateToken = function(req, res, next) {

    /** Validate authorization header is received */
    if (!req.headers.authorization) {
        res.send({ token: '', valid: false });
    }
    
    /** Trim simple or double quotes in token if neccessary */
    var token = req.headers.authorization.replace(/['"]+/g, '');
    try {
        /**
         * Try to get user by token data
         * @memberof module:auth.getUserByToken
         * */
        getUserByToken(token).then(data => {
            /** return data */
            res.send(data);
        }).catch(err => {
            /** return data */
            res.send(err);
        });

    } catch (ex) {
        /** return same token and invalid flag */
        res.send({ token: token, valid: false, status: '4' });
    }
}


/**
 * @description Controller function that handles when user request for a password restore
 *
 * @typedef {Object} requestBody
 * @property {number} req.body.email - User token information
 * 
 * @param {Express.Request<{},{},requestBody>} req
 * @param {Express.Response} res
 * @param {Function} next
 * 
 * @typedef {Object} responseData
 * @param   {String} email - User email that has requested the password restoration
 * 
 * @param {Function(responseData)} data - res.send
 * 
 * @returns {void}
 */
exports.forgotPasswordRequest = async function(req, res, next) {
    
    /** Finish current request and delegates to master handling error if email is not received */
    if (!req.body.email) {
        next({ status: 200, message: 'Email is required.' });
        return;
    }

    /** Look for some user wich is requesting the password restoration */
    let userData = await User.findOne({ email: req.body.email });

    /** If user exists, then store new request */
    if (userData && userData._id) {

        /** Create new password request with the user ID from the module:models/catalog.UserPassword  */
        var tmp_access = new UserPassword({ _user: userData._id });

        /** Save current request data into database */
        tmp_access.save((err, access_stored) => {

            /** Validate error not exists and request has been proccessed */
            if (!err && access_stored) {
                /**
                 * Define object to send by email
                 * {subject: string, recipients: object, template: string} options
                */
                var options = {
                    subject: 'Solicitud de reestablecimiento de contrase??a para ' + config.options.p,
                    recipients: {},
                    template: 'protec-resetaccount'
                }
                /** Generate recipients variable in format { email: { foo: var } } */
                /** Some random code was generated to send by email */
                options.recipients[userData.email] = {
                    'code': access_stored.code,
                    'name': userData.firstname + ' ' + userData.lastname
                };

                /** Send mail from module:services/mailing.send */
                mailing.send(options, function (mailResult) {
                    console.log('mail result', mailResult);
                });

            } else {
                /* if some error, don't say that confidential information to final user, just send to log */
                console.error('password restore error', access_stored);
                console.error('error', err);
            }

        });

    }

    /**  Send response defined in res.send structure */
    res.send({
        email: req.body.email
    });
    
}


/**
 * @description Controller function that handles when user request for a password restore
 *
 * @typedef {Object} requestBody
 * @property {string} req.body.code - Previous code sent to user
 * 
 * @param {Express.Request<{},{},requestBody>} req
 * @param {Express.Response} res
 * @param {Function} next
 * 
 * @typedef {Object} responseData
 * @param   {String} token
 * 
 * @param {Function(responseData)} data - res.send
 * 
 * @returns {void}
 */
exports.forgotPasswordRequestCode = async function(req, res, next) {
    /** Validate code is received */
    if (!req.body.code) {
        next({ status: 200, message: 'Code is required.' });
        return;
    }
    /** currentTime - Get current time to have no expired code */
    let currentTime = new Date();
    /** let's find password request from some code wich is not used and isn't expired */
    let userCode = await UserPassword.findOne({code: req.body.code, valid_until: { $gte: currentTime }, used: { $exists: false } }).sort({created_at: -1});

    /** If requested code complies with previous characteristics */
    if ( userCode && userCode._id ) {

        /** Define datetime where code was used */
        userCode.used = currentTime;
        /** Update request password data in database */
        userCode.save();

        /** return new temporary token data */
        let token_data = {
            iat: moment().unix(),
            exp: moment().add(30, 'minutes').unix(),
            code: userCode.code,
            _id: userCode._id
        }
    
        /** newToken - This variable includes encoded JWT wich could be exchanged for a new token */
        let newToken = jwt.createToken(token_data);
        /**  Send response defined in res.send structure */
        res.send({token: newToken });
    } else {
        /**  request code wasn't found, pass error to main handling error */
        next({ status: 200, message: 'Code not found or expired.' });
    }
    
}


/**
 * @description Controller function that handles when user request for a password restore
 *
 * @typedef {Object} requestBody
 * @property {string} req.body.token - Previous temporary token sent
 * @property {string} req.body.password - New password to be stored
 * 
 * @param {Express.Request<{},{},requestBody>} req
 * @param {Express.Response} res
 * @param {Function} next
 * 
 * @typedef {Object} responseData
 * @param   {String} token - Previous token sent to user
 * 
 * @param {Function(responseData)} data - res.send
 * 
 * @returns {void}
 */
exports.resetPassword = async function(req, res, next) {
    /** Validate token and password has been received */
    if (!req.body.token ||??!req.body.password ||??req.body.password.length < 6) {
        next({ status: 200, message: 'Token is required & password min length is 6.' });
        return;
    }
    
    /** Token received should be decoded */
    let token = jwt.decodeToken( req.body.token );

    /** Validate token data includes "code" key and value isn't empty */
    if ( token && token.code ) {
        /** currentTime - Store current datetime where password is setup */
        let currentTime = new Date();
        /** Validate previous code has been exchanged for a token */
        let userCode = await UserPassword.findOne({code: token.code, valid_until: { $gte: currentTime }, used: { $exists: true, $lte: currentTime }, pwd_changed: { $exists: false } });
        /** If userCode exists */
        if ( userCode && userCode._id ) {
            /** Get user info by password request data */
            let userData = await User.findOne({_id: userCode._user});
            /** Validate user still exists */
            if ( userData && userData._id ) {
                /** Change user secret key by a random one for security reasons */
                userData.secret_key = Math.random().toString(36).replace(/[^a-z]+/g, '').substr(0, 16);
                /** Encrypt new password */
                userData.password = bcrypt.hashSync(userData.secret_key+'-'+req.body.password, config.bcrypt_rounds);
                /** Save new user data */
                userData.save();
                /** Save time when password has changed */
                userCode.pwd_changed = currentTime;
                userData.save();

                /**  Send response defined in res.send structure */
                res.send({
                    email: req.body.token
                });

            } else {
                /** Assocciated user to a password request doesn't exists */
                next({ status: 200, message: 'Token not found or expired. 1' });
            }
        } else {
            /** Previous code may be expired, or token has been minupulated */
            next({ status: 200, message: 'Token not found or expired. 2' });
        }
    } else {
        /** If token sent is not valid */
        next({ status: 200, message: 'Token not found or expired. 3' });
    }

    
}



/**
 * @description Internal and exported function retrives an user from an authentication token
 *
 * @param   {String} token - Previous token sent to user
 * 
 * @typedef {response}
 * @property {tenants} - All tenants assigned to user
 * @property {current_tenant} - Current tenant where the request cames from
 * @property {user} - Current user data info
 * @property {valid} - Boolean
 * 
 * @returns {Promise(response)} - Should return a response from current user
 */
var getUserByToken = exports.getUserByToken = function(token) {
    /** This function return a promise */
    return new Promise(function(resolve, reject) {
        try {
            /** Decode received token */
            var payload = jwt.decodeToken(token);
            /** Validate token exiparion and match with the current app key */
            if (jwt.validateExpiration(payload.exp) && jwt.validateKey(payload)) {
                /** Find user in database by user ID and tenant ID */
                User.findOne(
                    { $or: [
                        { _id: payload._user, '_tenants._tenant': payload._tenant },
                        { _id: payload._user, role: config.roles.admin },
                    ] }
                    /** Explicitly expose secret key to validate */
                ).select('+secret_key').exec((err, user) => {
                    /** Validate user exists */
                    if (err || !user ) {
                        reject({ token: token, valid: false, status: '1' });
                    } else {
                        /** Add custom tenant if user is admin (only if previous tenant not included) */
                        if ( user.role == config.roles.admin && !user._tenants.find( tn => tn._tenant == payload._tenant )) {
                            user._tenants.push({
                                _tenant: payload._tenant
                            })
                        }
                        /** Pupulate data with tenants and roles data */
                        var populate = [
                            { path: '_tenants._tenant', select: 'name img color' },
                            { path: '_tenants._role', populate: { path: 'permissions', select: 'slug -_id' }, select: '-_id -_tenant' }
                        ];
                        user.populate(populate, function(err) {
                            /** Some error has been received from the DB*/
                            if (!err) {
                                /** Convert user data to a simple object to manipulate it */
                                let tmp_user = user.toObject();
                                /** Remove sensible data */
                                delete tmp_user._tenants;
                                delete tmp_user.device_tokens;
                                delete tmp_user.secret_key;
                                
                                /** Map user tenants and permissions */
                                let simple_tenants = user._tenants.toObject().map( tn => {
                                    /** Define empty role if not exists anymore */
                                    if (!tn._role) {
                                        tn._role = {};
                                    }
                                    /** Define empty permissions in case role don't include it */
                                    if (!tn._role.permissions) {
                                        tn._role.permissions = [];
                                    }
                                    /** Return only slug permissions */
                                    tn._role.permissions = tn._role.permissions.map( p => p.slug )
                                    /** create different token per tenant */
                                    tn.token = jwt.createToken({
                                        _user: tmp_user._id,
                                        _tenant: tn._tenant._id,
                                        key: user.secret_key
                                    });
                                    /** return tenant data inside map */
                                    return tn;
                                }).filter( tn => tn.active );
                                /** resolve function with defined structure */
                                resolve({
                                    tenants: simple_tenants,
                                    current_tenant: simple_tenants.find( tn => tn._tenant._id == payload._tenant ),
                                    user: tmp_user,
                                    valid: true
                                });
    
                            } else {
                                /** reject response, some error occurred in database */
                                reject({ token: token, valid: false, status: '2' });
                            }
                        })
                    }
                });
            } else {
                /** reject response, token is invalid */
                reject({ token: token, valid: false, status: '3' });
            }
        } catch( err ) {
            /** reject response, something went wrong when decoding token */
            reject({ token: token, valid: false, status: '4' });
        }
    });
}
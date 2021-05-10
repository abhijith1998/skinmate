/* eslint-disable no-console */
const { compare } = require('bcryptjs');
const { Router, urlencoded } = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { User, Client, TOTP } = require('../database');
const {
  constants, middlewares, errors, otp, emailServer, smsServer,
} = require('../utils');

const router = Router();

/**
 * `http POST` request handler for user creation.
 * * Requires `user-agent` to be present
 */
router.post(
  '/accounts',
  urlencoded({ extended: true }),
  middlewares.requireHeaders({ userAgent: true }),
  async (request, response) => {
    try {
      // Check if user exists
      if (await User.exists({ email: request.body.email })) {
        response.status(errors.USER_EXISTS.code);
        throw errors.USER_EXISTS.error;
      }

      // Create a user document, extract and assign values to prevent injection attacks
      const user = new User({
        email: request.body.email,
        password: request.body.password,
        phone: request.body.phone,
      });

      // Validate the document before generating a client
      await user.validate()
        .catch((error) => {
          console.error(error);
          const validationError = errors.VALIDATION_ERROR(error);
          response.status(validationError.code);
          throw validationError.error;
        });

      await user.save().catch((error) => {
        console.error(error);
        response.status(errors.SAVE_USER_FAILED.code);
        throw errors.SAVE_USER_FAILED.error;
      });

      // On-register-direct-login approach
      const client = await Client.create({ user: user.id, userAgent: request.headers['user-agent'] })
        .catch((error) => {
          console.error(error);
          response.status(errors.SAVE_CLIENT_FAILED.code);
          throw errors.SAVE_CLIENT_FAILED.error;
        });

      response.status(201).json(client);
    } catch (error) {
      response.send(error.message);
    }
  },
);

/**
 * `http GET` request handler to fetch user
 * * Requires `access-token` `device-id` `user-agent`
 */
router.get(
  '/accounts',
  middlewares.requireHeaders({ accessToken: true, deviceId: true }),
  middlewares.requireVerification({ phone: true, email: true }),
  async (request, response) => {
    try {
      // Get the user document
      const user = await User.findOne({
        _id: request.params.userId,
        isDeleted: { $ne: true },
      }).catch((error) => {
        console.error(error);
        response.status(errors.FIND_USER_FAILED.code);
        throw errors.FIND_USER_FAILED.error;
      });

      const { password, isDeleted, ...rest } = user.toJSON();

      response.json(rest);
    } catch (error) {
      console.error(error);
      response.send(error.message);
    }
  },
);

const upload = multer({
  limits: { fileSize: 1000000 },
  fileFilter(_, file, cb) {
    let error = null;
    if (!file.originalname.match(/\.(jpg|jpeg|png)$/)) {
      error = new Error('Not a JPEG/PNG image');
      // return cb(new Error('Not a JPEG/PNG image'));
    }
    // cb(null, true);
    // return null;
    return cb(error, !!error);
  },
});

/**
 * `http POST` request handler to upload user profile avatar
 * * Requires `access-token` `device-id` `user-agent`
 */
router.post(
  '/accounts/avatar',
  middlewares.requireHeaders({ accessToken: true, deviceId: true }),
  middlewares.requireVerification({ phone: true, email: true }),
  upload.single('file'),
  async (request, response) => {
    try {
      // Get the use document
      const user = await User.findById(request.params.userId)
        .catch((error) => {
          console.error(error);
          response.status(errors.FIND_USER_FAILED.code);
          throw errors.FIND_USER_FAILED.error;
        });

      const buffer = await sharp(request.file.buffer)
        .png()
        .toBuffer()
        .catch((error) => {
          console.log(error);
          response.status(errors.IMAGE_READ_FAILED.code);
          throw errors.IMAGE_READ_FAILED.error;
        });

      user.avatar = buffer;

      await user.save();

      response.send('avatar uploaded');
    } catch (error) {
      response.send(error.message);
    }
  },
);

/**
 * `http PATCH` request handler to edit user profile
 * * Requires `access-token` `device-id`
 */
router.patch(
  '/accounts',
  urlencoded({ extended: true }),
  middlewares.requireHeaders({ accessToken: true, deviceId: true }),
  middlewares.requireVerification({ phone: true }),
  async (request, response) => {
    try {
      // Get the user document
      const user = await User.findOne({
        _id: request.params.userId,
        isDeleted: { $ne: true },
      }).catch((error) => {
        console.error(error);
        response.status(errors.FIND_USER_FAILED.code);
        throw errors.FIND_USER_FAILED.error;
      });

      const updates = Object.keys(request.body);
      const allowedUpdates = ['firstName', 'lastName', 'password', 'gender', 'dateOfBirth', 'bloodGroup', 'address', 'insurance', 'emergencyName', 'emergencyNumber'];
      const isvalidoperation = updates.every((update) => allowedUpdates.includes(update));

      if (!isvalidoperation) {
        const { code, error } = errors.FORBIDDEN_UPDATE_ERROR(updates
          .filter((key) => !allowedUpdates.includes(key)));
        response.status(code);
        throw error;
      }

      updates.forEach((update) => {
        user[update] = request.body[update];
      });

      // Validate the document before updating
      await user.validate()
        .catch((error) => {
          console.error(error);
          const validationError = errors.VALIDATION_ERROR(error);
          response.status(validationError.code);
          throw validationError.error;
        });

      await user.save().catch((error) => {
        console.error(error);
        response.status(errors.USER_UPDATE_FAILURE.code);
        throw errors.USER_UPDATE_FAILURE.error;
      });

      const {
        password, isDeleted, avatar, ...rest
      } = user.toJSON();

      response.json(rest);
    } catch (error) {
      console.log(error);
      response.send(error.message);
    }
  },
);

/**
 * `http DELETE` request handler to delete user
 * * Requires `access-token` `device-id`
 */
router.delete(
  '/accounts',
  middlewares.requireHeaders({ accessToken: true, deviceId: true }),
  middlewares.requireVerification({ phone: true }),
  async (request, response) => {
    try {
      // Get the user
      const user = await User.findOne({
        _id: request.params.userId,
        isDeleted: { $ne: true },
      }).catch((error) => {
        console.error(error);
        response.status(errors.FIND_USER_FAILED.code);
        throw errors.FIND_USER_FAILED.error;
      });

      await user.update({ isDeleted: true })
        .catch((error) => {
          console.error(error);
          response.status(errors.USER_UPDATE_FAILURE.code);
          throw errors.USER_UPDATE_FAILURE.error;
        });

      response.send('Account deleted');
    } catch (error) {
      response.send(error.message);
    }
  },
);

/**
 * `http POST` request handler for user authentication (signin).
 * * Requires `user-agent` to be present
 * * Optional `device-id`
 */
router.post(
  '/accounts/auth',
  urlencoded({ extended: true }),
  middlewares.requireHeaders({ userAgent: true }),
  async (request, response) => {
    try {
      // Get the user
      const user = await User.findOne({
        $or: [{
          email: request.body.email,
        }, {
          phone: request.body.phone,
        }],
        isDeleted: { $ne: true },
      }).catch((error) => {
        console.error(error);
        response.status(errors.FIND_USER_FAILED.code);
        throw errors.FIND_USER_FAILED.error;
      });

      if (!user) {
        response.status(errors.NULL_USER.code);
        throw errors.NULL_USER.error;
      }

      // Check password
      const isPasswordValid = await compare(request.body.password, user.password)
        .catch((error) => {
          console.error(error);
          response.status(errors.PASSWORD_COMPARE_FAILED.code);
          throw errors.PASSWORD_COMPARE_FAILED.error;
        });

      if (!isPasswordValid) {
        response.status(errors.PASSWORD_INCORRECT.code);
        throw errors.PASSWORD_INCORRECT.error;
      }

      let client = await Client.findOne({ _id: request.headers['device-id'] })
        .catch((error) => {
          console.error(error);
          // Safe skip
        });

      if (client) {
        client = await client.save();
      } else {
        client = await Client.create({ user: user.id, userAgent: request.headers['user-agent'] })
          .catch((error) => {
            console.error(error);
            response.status(errors.SAVE_CLIENT_FAILED.code);
            throw errors.SAVE_CLIENT_FAILED.error;
          });
      }

      response.json(client);
    } catch (error) {
      response.send(error.message);
    }
  },
);

/**
 * `http PURGE` request handler for user authentication (signout).
 * * Requires `access-token` `device-id` to be present
 */
router.purge(
  '/accounts/auth',
  middlewares.requireHeaders({ accessToken: true, deviceId: true }),
  middlewares.requireVerification({}),
  async (request, response) => {
    try {
      await Client.deleteOne({
        _id: request.headers['device-id'],
        token: request.headers['access-token'],
      })
        .catch((error) => {
          console.error(error);
          response.status(500);
          throw new Error('Couldn\'t sign you out');
        });

      response.send('You\'re signed out');
    } catch (error) {
      response.send(error.message);
    }
  },
);

/**
 * `http GET` request handler for user phone verification.
 * * Requires `access-token` `device-id` to be present
 */
router.get(
  '/accounts/verify/phone',
  middlewares.requireHeaders({ accessToken: true, deviceId: true }),
  middlewares.requireVerification({}),
  async (request, response) => {
    try {
      // Get the user
      const user = await User.findById(request.params.userId)
        .catch((error) => {
          console.error(error);
          response.status(errors.FIND_USER_FAILED.code);
          throw errors.FIND_USER_FAILED.error;
        });

      if (user.verifiedPhone) {
        response.status(errors.PHONE_ALREADY_VERIFIED.code);
        throw errors.PHONE_ALREADY_VERIFIED.error;
      }

      // Generate a TOTP document
      const totp = await TOTP.create({ user: user.id })
        .catch((error) => {
          console.error(error);
          response.status(errors.OTP_GENERATION_FAILED.code);
          throw errors.SAVE_TOTP_FAILED.error;
        });

      // Send OTP to user.phone
      await smsServer.sendSMS(
        user.phone,
        constants.SMS_TEMPLATE_VERIFICATION,
        {
          MESSAGE: 'Verify and confirm your contact number.',
          VERIFICATION_CODE: otp.generateOTP(totp.secret),
        },
      ).catch((error) => {
        console.error(error);
        response.status(errors.OTP_SEND_FAILED.code);
        throw errors.OTP_SEND_FAILED.error;
      });

      const { secret, ...rest } = totp.toJSON();

      // Send secret to user
      response.json(rest);
    } catch (error) {
      response.send(error.message);
    }
  },
);

/**
 * `http POST` request handler for user phone verification.
 * * Requires `access-token` `device-id` to be present in the headers.
 * * Requires `requestId` `code` to be sent in the body.
 */
router.post(
  '/accounts/verify/phone',
  urlencoded({ extended: true }),
  middlewares.requireHeaders({ accessToken: true, deviceId: true }),
  middlewares.requireVerification({}),
  async (request, response) => {
    try {
      // Get the user
      const user = await User.findById(request.params.userId)
        .catch((error) => {
          console.error(error);
          response.status(errors.FIND_USER_FAILED.code);
          throw errors.FIND_USER_FAILED.error;
        });

      // Get the TOTP document
      const totp = await TOTP.findOne({
        _id: request.body.requestId,
        user: user.id,
      }).catch((error) => {
        console.error(error);
        response.status(errors.FIND_TOTP_FAILED.code);
        throw errors.FIND_TOTP_FAILED.error;
      });

      if (!totp) {
        response.status(errors.UNAVAILABLE_OTP.code);
        throw errors.UNAVAILABLE_OTP.error;
      }

      // Verify OTP
      if (!otp.verifyOTP(totp.secret, request.body.code)) {
        response.status(errors.INVALID_OTP.code);
        throw errors.INVALID_OTP.error;
      }

      // Remove totp document to prevent breach
      totp.remove().catch((error) => {
        console.error(error);
      });

      user.verifiedPhone = true;
      await user.save();

      // Acknowledge on success
      response.send(`${user.phone} is now verified`);
    } catch (error) {
      response.send(error.message);
    }
  },
);

/**
 * `http GET` request handler for user email verification.
 * * Requires `access-token` `device-id` to be present
 * * Requires `user.phone` to be verified
 */
router.get(
  '/accounts/verify/email',
  middlewares.requireHeaders({ accessToken: true, deviceId: true }),
  middlewares.requireVerification({ phone: true }),
  async (request, response) => {
    try {
      // Get the user
      const user = await User.findById(request.params.userId)
        .catch((error) => {
          console.error(error);
          response.status(errors.FIND_USER_FAILED.code);
          throw errors.FIND_USER_FAILED.error;
        });

      if (user.verifiedEmail) {
        response.status(errors.EMAIL_ALREADY_VERIFIED.code);
        throw errors.EMAIL_ALREADY_VERIFIED.error;
      }

      // Generate a TOTP document
      const totp = await TOTP.create({ user: user.id })
        .catch((error) => {
          console.error(error);
          response.status(errors.OTP_GENERATION_FAILED.code);
          throw errors.OTP_GENERATION_FAILED.error;
        });

      // Send OTP to user.email
      await emailServer.sendMail(
        user.email,
        'SkinMate Email Verification',
        constants.EMAIL_TEMPLATE_VERIFICATION,
        {
          MESSAGE: 'Please use the OTP below to verify and confirm your email address.',
          VERIFICATION_CODE: otp.generateOTP(totp.secret),
        },
      ).catch((error) => {
        console.error(error);
        response.status(errors.OTP_SEND_FAILED.code);
        throw errors.OTP_SEND_FAILED.error;
      });

      const { secret, ...rest } = totp.toJSON();

      // Send secret to user
      response.json(rest);
    } catch (error) {
      response.send(error.message);
    }
  },
);

/**
 * `http POST` request handler for user email verification.
 * * Requires `access-token` `device-id` to be present in the headers.
 * * Requires `requestId` `code` to be sent in the body.
 * * Requires `user.phone` to be verified
 */
router.post(
  '/accounts/verify/email',
  urlencoded({ extended: true }),
  middlewares.requireHeaders({ accessToken: true, deviceId: true }),
  middlewares.requireVerification({ phone: true }),
  async (request, response) => {
    try {
      // Get the user
      const user = await User.findById(request.params.userId)
        .catch((error) => {
          console.error(error);
          response.status(errors.FIND_USER_FAILED.code);
          throw errors.FIND_USER_FAILED.error;
        });

      // Get the TOTP document
      const totp = await TOTP.findOne({
        _id: request.body.requestId,
        user: user.id,
      }).catch((error) => {
        console.error(error);
        response.status(errors.FIND_TOTP_FAILED.code);
        throw errors.FIND_TOTP_FAILED.error;
      });

      if (!totp) {
        response.status(errors.UNAVAILABLE_OTP.code);
        throw errors.UNAVAILABLE_OTP.error;
      }

      // Verify OTP
      if (!otp.verifyOTP(totp.secret, request.body.code)) {
        response.status(errors.INVALID_OTP.code);
        throw errors.INVALID_OTP.error;
      }

      // Remove totp document to prevent breach
      totp.remove().catch((error) => {
        console.error(error);
      });

      user.verifiedEmail = true;
      await user.save();

      // Acknowledge on success
      response.send(`${user.email} is now verified`);
    } catch (error) {
      response.send(error.message);
    }
  },
);

/**
 * `http POST` request handler for requesting OTP signin.
 * * Requires `user-agent` to be present in the headers.
 * * Requires `email` or `phone` to be sent in the body.
 * * Requires `user.phone` to be verified
 */
router.post(
  '/accounts/auth/request-otp-signin',
  urlencoded({ extended: true }),
  middlewares.requireHeaders({ userAgent: true }),
  async (request, response) => {
    try {
      // Get the user document
      const user = await User.findOne({
        $or: [
          { email: request.body.email },
          { phone: request.body.phone },
        ],
        isDeleted: { $ne: true },
      }).catch((error) => {
        console.error(error);
        response.status(errors.FIND_USER_FAILED.code);
        throw errors.FIND_USER_FAILED.error;
      });

      if (!user) {
        response.status(errors.NULL_USER.code);
        throw errors.NULL_USER.error;
      }

      // Generate a TOTP document
      const totp = await TOTP.create({ user: user.id })
        .catch((error) => {
          console.error(error);
          response.status(errors.OTP_GENERATION_FAILED.code);
          throw errors.OTP_GENERATION_FAILED.error;
        });

      // Send OTP if email
      if (request.body.email) {
        // Send OTP to user.email
        await emailServer.sendMail(
          user.email,
          'SkinMate Password Reset OTP',
          constants.EMAIL_TEMPLATE_VERIFICATION,
          {
            MESSAGE: 'Please use the OTP below to confirm and proceed with your password reset. This OTP allows you to login and update your password.',
            VERIFICATION_CODE: otp.generateOTP(totp.secret),
          },
        ).catch((error) => {
          console.error(error);
          response.status(errors.OTP_SEND_FAILED.code);
          throw errors.OTP_SEND_FAILED.error;
        });
      }

      // Send OTP if phone
      if (request.body.phone) {
        await smsServer.sendSMS(
          user.phone,
          constants.SMS_TEMPLATE_VERIFICATION,
          {
            MESSAGE: 'Use this OTP to login and change your password.',
            VERIFICATION_CODE: otp.generateOTP(totp.secret),
          },
        ).catch((error) => {
          console.error(error);
          response.status(errors.OTP_SEND_FAILED.code);
          throw errors.OTP_SEND_FAILED.error;
        });
      }

      const { secret, ...rest } = totp.toJSON();

      response.send(rest);
    } catch (error) {
      response.send(error.message);
    }
  },
);

/**
 * `http POST` request handler for OTP signin
 * * Requires `user-agent` to be present in the headers.
 * * Requires `requestId` `code` to be sent in the body.
 */
router.post(
  '/accounts/auth/otp-signin',
  urlencoded({ extended: true }),
  middlewares.requireHeaders({ userAgent: true }),
  async (request, response) => {
    try {
      // Get the TOTP document
      const totp = await TOTP.findOne({
        _id: request.body.requestId,
      }).catch((error) => {
        console.error(error);
        response.status(errors.FIND_TOTP_FAILED.code);
        throw errors.FIND_TOTP_FAILED.error;
      });

      if (!totp) {
        response.status(errors.UNAVAILABLE_OTP.code);
        throw errors.UNAVAILABLE_OTP.error;
      }

      // Verify OTP
      if (!otp.verifyOTP(totp.secret, request.body.code)) {
        response.status(errors.INVALID_OTP.code);
        throw errors.INVALID_OTP.error;
      }

      const client = await Client.create({
        user: totp.user,
        userAgent: request.headers['user-agent'],
      }).catch((error) => {
        console.error(error);
        response.status(errors.SAVE_CLIENT_FAILED.code);
        throw errors.SAVE_CLIENT_FAILED.error;
      });

      // Remove totp document to prevent breach
      totp.remove().catch((error) => {
        console.error(error);
      });

      response.json(client);
    } catch (error) {
      response.send(error.message);
    }
  },
);

/**
 * User router
 */
module.exports = router;

/* eslint-disable no-console */
const { compare } = require('bcryptjs');
const { Router, urlencoded } = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { User, Client, TOTP } = require('../database');
const {
  constants, middlewares, errors, otp, emailServer, smsServer,
} = require('../utils');
const path = require("path"); 
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

      // On-register-direct-login approach
      const client = await Client.create({ user: user.id, userAgent: request.headers['user-agent'] })
        .catch((error) => {
          console.error(error);
          response.status(errors.SAVE_CLIENT_FAILED.code);
          throw errors.SAVE_CLIENT_FAILED.error;
        });

      // Add the client
      user.clients.push(client.id);

      await user.save().catch((error) => {
        console.error(error);
        response.status(errors.SAVE_USER_FAILED.code);
        throw errors.SAVE_USER_FAILED.error;
      });

      const { isDeleted, ...rest } = client.toJSON();

      response.status(201).json(rest);
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

      const populatedUser = await user.populate({
        path: 'clients',
        select: 'userAgent createdAt',
        match: { isDeleted: { $ne: true } },
      }).execPopulate();

      const { password, isDeleted, ...rest } = populatedUser.toJSON();

      response.json(rest);
    } catch (error) {
      console.error(error);
      response.send(error.message);
    }
  },
);

/**
 * @adminOnly
 * `http GET` request handler to fetch a user
 */
router.get(
  '/accounts/:id',
  middlewares.requireHeaders({ accessToken: true, deviceId: true }),
  middlewares.requireVerification({ admin: true }),
  async (request, response) => {
    try {
      // Get the user document
      const user = await User.findById(request.params.id)
        .catch((error) => {
          console.error(error);
          response.status(errors.FIND_USER_FAILED.code);
          throw errors.FIND_USER_FAILED.error;
        });

      if (!user) {
        response.status(errors.NULL_USER.code);
        throw errors.NULL_USER.error;
      }

      // Populate client details
      const populatedUser = await user.populate({
        path: 'clients',
        select: 'userAgent createdAt',
      }).execPopulate();

      const { password, ...rest } = populatedUser.toJSON();

      response.json(rest);
    } catch (error) {
      console.error(error);
      response.send(error.message);
    }
  },
);

// const upload = multer({
//   limits: { fileSize: 1000000 },
//   fileFilter(_, file, cb) {
//     let error = null;
//     if (!file.originalname.match(/\.(jpg|jpeg|png)$/)) {
//       error = new Error('Not a JPEG/PNG image');
//       // return cb(new Error('Not a JPEG/PNG image'));
//     }
//     // cb(null, true);
//     // return null;
//     return cb(error, !!error);
//   },
// });

/** Storage Engine */
const storageEngine = multer.diskStorage({
  destination: "../src/assets/avatar",
  filename: function (req, file, fn) {
    fn(
      null,
      new Date().getTime().toString() +
        "-" +
        file.fieldname +
        path.extname(file.originalname)
    );
  },
});

//validation
const upload = multer({
  storage: storageEngine,
  limits: { fileSize: 200000 },
  fileFilter: function (req, file, callback) {
    validateFile(file, callback);
  },
});

let validateFile = function (file, cb) {
  allowedFileTypes = /jpeg|jpg|png/;
  const extension = allowedFileTypes.test(
    path.extname(file.originalname).toLowerCase()
  );
  const mimeType = allowedFileTypes.test(file.mimetype);
  if (extension && mimeType) {
    return cb(null, true);
  } else {
    cb("Invalid file type. Only JPEG, PNG and JPG are allowed.");
  }
};

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

//       const buffer = await sharp(request.file.buffer)
//         .png()
//         .toBuffer()
//         .catch((error) => {
//           console.log(error);
//           response.status(errors.IMAGE_READ_FAILED.code);
//           throw errors.IMAGE_READ_FAILED.error;
//         });

//       user.avatar = buffer;

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
      const updates = Object.keys(request.body);
      const updatable = ['firstName', 'lastName', 'password', 'gender', 'dateOfBirth', 'bloodGroup', 'address', 'insurance', 'emergencyName', 'emergencyNumber'];
      const isValidOperation = updates.every((update) => updatable.includes(update));

      if (!isValidOperation) {
        const { code, error } = errors.FORBIDDEN_FIELDS_ERROR(updates
          .filter((key) => !updatable.includes(key)));
        response.status(code);
        throw error;
      }

      // Get the user document
      const user = await User.findOne({
        _id: request.params.userId,
        isDeleted: { $ne: true },
      }).catch((error) => {
        console.error(error);
        response.status(errors.FIND_USER_FAILED.code);
        throw errors.FIND_USER_FAILED.error;
      });

      updates.forEach((update) => {
        user[update] = request.body[update];
      });

      // Validate the document before updating
      await user.validate().catch((error) => {
        console.error(error);
        const validationError = errors.VALIDATION_ERROR(error);
        response.status(validationError.code);
        throw validationError.error;
      });

      await user.save().catch((error) => {
        console.error(error);
        response.status(errors.UPDATE_USER_FAILED.code);
        throw errors.UPDATE_USER_FAILED.error;
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

      const u = await Client.find({
        _id: { $in: user.clients },
      });

      console.log(u);

      // await user.update({ isDeleted: true })
      //   .catch((error) => {
      //     console.error(error);
      //     response.status(errors.USER_UPDATE_FAILURE.code);
      //     throw errors.USER_UPDATE_FAILURE.error;
      //   });

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

      // Soft delete existing client
      if (await Client.exists({
        _id: request.headers['device-id'],
        isDeleted: { $ne: true },
      })) {
        await Client.updateOne(
          { _id: request.headers['device-id'] },
          { isDeleted: true },
        );
      }

      const client = await Client.create({ userAgent: request.headers['user-agent'] })
        .catch((error) => {
          console.error(error);
          response.status(errors.SAVE_CLIENT_FAILED.code);
          throw errors.SAVE_CLIENT_FAILED.error;
        });

      user.clients.push(client.id);

      await user.save().catch((error) => {
        console.error(error);
        response.status(errors.UPDATE_USER_FAILED.code);
        throw errors.SAVE_USER_FAILED.error;
      });

      const { isDeleted, ...rest } = client.toJSON();

      response.json(rest);
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
      await Client.updateOne({
        _id: request.headers['device-id'],
        token: request.headers['access-token'],
        is: { $ne: true },
      }, { isDeleted: true }).catch((error) => {
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
router.get(
  '/accounts/auth/otp-signin',
  urlencoded({ extended: true }),
  middlewares.requireHeaders({ userAgent: true }),
  async (request, response) => {
    try {
      // Get the user document
      const user = await User.findOne({
        $or: [
          { email: request.query.email },
          { phone: request.query.phone },
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

      // Get the requested user
      const user = await User.findOne({
        _id: totp.user,
        isDeleted: { $ne: true },
      }).catch((error) => {
        console.error(error);
        response.status(errors.FIND_USER_FAILED.code);
        throw errors.FIND_USER_FAILED.error;
      });

      const client = await Client.create({
        userAgent: request.headers['user-agent'],
      }).catch((error) => {
        console.error(error);
        response.status(errors.SAVE_CLIENT_FAILED.code);
        throw errors.SAVE_CLIENT_FAILED.error;
      });

      user.clients.push(client.id);

      await user.save().catch((error) => {
        console.error(error);
        response.status(errors.UPDATE_USER_FAILED.code);
        throw errors.UPDATE_USER_FAILED.error;
      });

      // Remove totp document to prevent breach
      totp.remove().catch((error) => {
        console.error(error);
      });

      const { isDeleted, ...rest } = client.toJSON();

      response.json(rest);
    } catch (error) {
      response.send(error.message);
    }
  },
);

/**
 * User router
 */
module.exports = router;

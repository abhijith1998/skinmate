/* eslint-disable no-console */
const { compare } = require('bcryptjs');
const { Router, urlencoded } = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { User, Client } = require('../database');

const router = Router();

/**
 * `http POST` request handler for user creation.
 * * Requires `user-agent` to be present
 */
router.post(
  '/accounts',
  urlencoded({ extended: true }),
  async (request, response) => {
    try {
      // Check `user-agent`
      if (!request.headers['user-agent']) {
        response.status(403);
        throw new Error('Requires user-agent');
      }

      // Check if user exists
      if (await User.exists({ email: request.body.email })) {
        response.status(409);
        throw new Error('Email already in use');
      }

      // Create a user document, extract and assign values to prevent injection attacks
      const user = new User({
        email: request.body.email,
        password: request.body.password,
        phone: request.body.phone,
        address: request.body.address,
        name: request.body.name,
      });

      // Validate the document before generating a client
      await user.validate()
        .catch((error) => {
          console.error(error);
          response.status(412);
          throw new Error(`Invalid details: ${error.message}`);
        });

      await user.save().catch((error) => {
        console.error(error);
        response.status(500);
        throw new Error(`Couldn't create user: ${error.message}`);
      });

      // On-register-direct-login approach
      const client = await Client.create({ user: user.id, userAgent: request.headers['user-agent'] })
        .catch((error) => {
          console.error(error);
          response.status(500);
          throw new Error('Couldn\'t add client');
        });

      response.status(201).json(client);
    } catch (error) {
      console.error(error);
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
  async (request, response) => {
    try {
      // Check `access-token`
      if (!request.headers['access-token']) {
        response.status(403);
        throw new Error('Requires access-token');
      }

      // Check `device-id`
      if (!request.headers['device-id']) {
        response.status(403);
        throw new Error('Requires device-id');
      }

      // Get the client document
      const client = await Client.findOne({
        _id: request.headers['device-id'],
        token: request.headers['access-token'],
      });

      if (!client) {
        response.status(403);
        throw new Error('Unrecognized device');
      }

      // Get the user
      const user = await User.findOne({ _id: client.user, isDeleted: { $ne: true } });

      if (!user) {
        response.status(404);
        throw new Error('Account not found');
      }

      const { password, isDeleted, ...rest } = user.toJSON();

      response.json(rest);
    } catch (error) {
      console.error(error);
      response.send(error.message);
    }
  },
);

const upload = multer({
  limits: {
    fileSize: 1000000,
  },
  fileFilter(request, file, cb) {
    if (!file.originalname.match(/\.(jpg|jpeg|png)$/)) return cb(new Error('pelase upload a jpeg or jpg or png'));
    cb(null, true);
    return null;
  },
});

router.post('/accounts/:userid/avatar', upload.single('file'), async (request, response) => {
  const buffer = await sharp(request.file.buffer).png().toBuffer();

  const user = await User.findById(request.params.userid);

  user.avatar = buffer;

  await user.save();

  response.send();
}, (error, request, response) => {
  response.status(400).send({ error });
});

/**
 * `http DELETE` request handler to delete user
 * * Requires `access-token` `device-id`
 */
router.delete(
  '/accounts',
  async (request, response) => {
    try {
      // Check `access-token`
      if (!request.headers['access-token']) {
        response.status(403);
        throw new Error('Requires access-token');
      }

      // Check `device-id`
      if (!request.headers['device-id']) {
        response.status(403);
        throw new Error('Requires device-id');
      }

      // Get the client document
      const client = await Client.findOne({
        _id: request.headers['device-id'],
        token: request.headers['access-token'],
      }).catch((error) => {
        console.error(error);
        response.status(500);
        throw new Error('Couldn\'t validate access');
      });

      if (!client) {
        response.status(403);
        throw new Error('Unrecognized device');
      }

      // Get the user
      const user = await User.findOne({
        _id: client.user,
        isDeleted: { $ne: true },
      }).catch((error) => {
        console.error(error);
        response.status(500);
        throw new Error('Couldn\'t find user');
      });

      if (!user) {
        response.status(404);
        throw new Error('Account not found');
      }

      await user.update({ isDeleted: true })
        .catch((error) => {
          console.error(error);
          response.status(500);
          throw new Error('Couldn\'t delete user');
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
  async (request, response) => {
    try {
      // Check `user-agent`
      if (!request.headers['user-agent']) {
        response.status(403);
        throw new Error('Requires user-agent');
      }

      // Check `device-id`
      if (!request.headers['device-id']) {
        response.status(403);
        throw new Error('Requires device-id');
      }

      // Get the user
      const user = await User.findOne({ email: request.body.email, isDeleted: { $ne: true } });

      if (!user) {
        response.status(404);
        throw new Error('Account not found');
      }

      // Check password
      const isPasswordValid = await compare(request.body.password, user.password)
        .catch((error) => {
          console.error(error);
          response.status(500);
          throw new Error('Couldn\'t verify password');
        });

      if (!isPasswordValid) {
        response.status(401);
        throw new Error('Incorrect password');
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
            response.status(500);
            throw new Error('Couldn\'t authenticate');
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
  async (request, response) => {
    try {
      // Check `access-token`
      if (!request.headers['access-token']) {
        response.status(403);
        throw new Error('Requires access-token');
      }

      // Check `device-id`
      if (!request.headers['device-id']) {
        response.status(403);
        throw new Error('Requires device-id');
      }

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
 * User router
 */
module.exports = router;

import RedisStore from 'connect-redis';
import dotenv from 'dotenv';
import express, { RequestHandler } from 'express';
import session from 'express-session';
import findConfig from 'find-config';
import passport from 'passport';
import { createClient } from 'redis';
import ViteExpress from 'vite-express';
// eslint-disable-next-line import/no-relative-packages
import { User as PrismaUser } from '../../prisma/client';
import oidc, { TODO_COOKIE_NAME } from './controllers/oidc';
import todo from './controllers/todo';
import user from './controllers/user';
import { JWT_STRATEGY_NAME, jwtStrategy } from './jwt/jwt-strategy';
import prisma from './prisma';

// Find the nearest .env and load it into process.ENV
dotenv.config({ path: findConfig('.env') || undefined });

const app = express();
app.use(express.json());

const redisClient = createClient({
  url: process.env.REDIS_SERVER,
});
redisClient.connect().catch(console.error);
const redisStore = new RedisStore({
  client: redisClient,
  prefix: 'todo0:',
});

const cookieSecret = process.env.COOKIE_SECRET;
if (!cookieSecret) {
  throw new Error('Missing env variable COOKIE_SECRET');
}

app.use(
  session({
    resave: false,
    saveUninitialized: false,
    secret: cookieSecret,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
    },
    // override the default cookie name so we can run both the app and auth server on localhost
    name: TODO_COOKIE_NAME,
    store: redisStore,
  })
);
app.use(passport.initialize());
app.use(passport.session());
passport.serializeUser(async (dbUser: PrismaUser, done) => {
  done(null, dbUser.id);
});

passport.deserializeUser(async (id: number, done) => {
  const dbUser = await prisma.user.findUnique({
    where: {
      id,
    },
  });

  done(null, dbUser);
});

passport.use(JWT_STRATEGY_NAME, jwtStrategy);

const authenticated: RequestHandler = (req, res, next) => {
  if (req.isUnauthenticated()) {
    // Use Passport JWT strategy to validate the Bearer token
    passport.authenticate(JWT_STRATEGY_NAME, {
      session: false, // Stateless JWT validation
      passReqToCallback: true,
      failWithError: false,
    })(req, res, next);
    return;
  }

  next();
};

app.use('/api/todos', authenticated, todo);
app.use('/api/users', authenticated, user);
app.use('/api/openid/', oidc);

ViteExpress.listen(app, 3001, () => console.log('Server is listening on port 3001...'));

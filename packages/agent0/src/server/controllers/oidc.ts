import { Router } from 'express';
import passport from 'passport';
import OpenIDConnectStrategy, { Profile, VerifyCallback } from 'passport-openidconnect';
import { AccessTokenResult, exchangeIdJwtAuthzGrant, ExchangeTokenResult, requestIdJwtAuthzGrant } from '../../../../id-assert-authz-grant-client';

import prisma from '../../prisma';

declare module 'express-session' {
  interface SessionData {
    authState?: {
      isAuthenticated: boolean;
      authToken?: string;
      authTimestamp?: number;
      userInfo?: any;
    };
  }
}

// Most of the code below comes from https://developer.okta.com/blog/2023/07/28/oidc_workshop
export const AGENT_COOKIE_NAME = 'agent.sid';
const controller: Router = Router();

async function orgFromDomain(domain: string) {
  const org = await prisma.organization.findFirst({
    where: {
      domain: domain,
    },
  });
  return org;
}

async function orgFromAuthServerOrgKey(key: string) {
  const org = await prisma.organization.findFirst({
    where: {
      auth_server_key: key,
    },
  });
  return org;
}

function getDomainFromEmail(email: string | undefined | null) {
  if (!email) {
    return null;
  }
  const [, domain] = email.split('@');
  return domain;
}

const verify = async (
  issuer: string,
  profile: Profile,
  context: object,
  idToken: object | string,
  done: VerifyCallback
) => {
  const externalId = profile.id;
  const authServerOrgKey = externalId.split(':')[0];
  const userId = externalId.split(':')[1];

  if (!authServerOrgKey || !userId) {
    throw new Error(`Could not parse profile.id for org and user id: ${JSON.stringify(profile)}`);
  }
  const org = await orgFromAuthServerOrgKey(authServerOrgKey);
  if (!org) {
    throw new Error(
      `No org found for key=${authServerOrgKey}, profile: ${JSON.stringify(profile)}`
    );
  }

  // Passport.js runs this verify function after successfully completing
  // the OIDC flow, and gives this app a chance to do something with
  // the response from the OIDC server, like create users on the fly.

  let user = await prisma.user.findFirst({
    where: {
      orgId: org.id,
      externalId: profile.id,
    },
  });

  if (!user) {
    // Ensure the profile response has the correct fields present to update or create a new user

    const emails = [...(profile.emails ?? [])];
    if (!emails || emails.length === 0) {
      emails.push({ value: 'bob@tables.fake' });
      return;
    }

    user = await prisma.user.findFirst({
      where: {
        orgId: org.id,
        email: emails[0].value,
      },
    });
    if (user) {
      await prisma.user.update({
        where: { id: user.id },
        data: { externalId: profile.id },
      });
    }

    if (!user) {
      user = await prisma.user.create({
        data: {
          org: { connect: { id: org.id } },
          externalId: profile.id,
          email: profile.emails![0].value,
          name: profile.displayName ?? emails[0]?.value,
        },
      });
    }
  }

// For all resources, do this flow
// Add code here to request an authorization grant token from the Identity Provider (IdP)


// Add code here to exchange the authorization grant token for an access token from the resource server (TODO Authorization Server)


// TODO: Refresh token
// Add code here to save the access token to the user record in the database


function createStrategy(username: string) {
  const strategyName = 'openidconnect';

  // Create and register the strategy (passport will handle duplicates)
  const strategy = new OpenIDConnectStrategy(
    {
      issuer: process.env.AUTH_SERVER!,
      authorizationURL: `${process.env.AUTH_SERVER}/auth`,
      tokenURL: `${process.env.AUTH_SERVER}/token`,
      userInfoURL: `${process.env.AUTH_SERVER}/me`,
      clientID: process.env.CLIENT1_CLIENT_ID!,
      clientSecret: process.env.CLIENT1_CLIENT_SECRET!,
      scope: 'profile email openid read write',
      callbackURL: `${process.env.AGENT_SERVER}/api/openid/callback/`,
      loginHint: username,
    },
    verify
  );

  // Unregister existing strategy if it exists and register new one
  try {
    passport.unuse(strategyName);
  } catch (e) {
    // Strategy doesn't exist, that's fine
  }
  passport.use(strategyName, strategy);

  return strategyName;
}

/**
 * Frontend UI can call this to see if the domain matches an Organization in the database.
 */
controller.post('/check', async (req, res) => {
  const { username } = req.body;

  const domain = getDomainFromEmail(username);
  if (domain) {
    let org = await prisma.organization.findFirst({
      where: {
        domain: domain,
      },
    });
    if (!org) {
      org = await prisma.organization.findFirst({
        where: {
          User: {
            some: {
              email: username,
            },
          },
        },
      });
    }
    if (org) {
      res.json({ orgId: org.id });
      return;
    }
  }

  res.json({ orgId: null });
});

controller.post('/signout', async (req, res, next) => {
  req.logout((err) => {
    if (err) {
      next(err);
    }
  });

  req.session.destroy((err) => {
    if (!err) {
      res
        .status(200)
        .clearCookie(AGENT_COOKIE_NAME, { path: '//anotherpath' })
        .json({ status: 'Success' });
    } else {
      next(err);
    }
  });
});

/**

/**
 * The frontend then redirects here to have the backend start the OIDC flow.
 * (You should probably use random IDs, not auto-increment integers
 * to avoid revealing how many enterprise customers you have.)
 */
controller.get('/start/:username', async (req, res, next) => {
  const domain = getDomainFromEmail(req.params.username);
  if (!domain) {
    res.sendStatus(404);
    return;
  }

  const org = await orgFromDomain(domain);
  if (!org) {
    res.sendStatus(404);
    return;
  }

  const strategyName = createStrategy(req.params.username);
  if (!strategyName) {
    res.sendStatus(404);
    return;
  }

  console.log('Starting authentication for:', req.params.username);
  passport.authenticate(strategyName)(req, res, next);
});

/**
 * Callback called from the Oauth server on succesful authentication.
 */
controller.get('/callback/', async (req, res, next) => {
  // Use the strategy name directly
  passport.authenticate('openidconnect', {
    failureRedirect: '/?auth=error',
    failureMessage: true,
  })(req, res, (err: any) => {
    if (err) {
      console.error('Authentication error:', err);
      return res.redirect('/?auth=error');
    }

    console.log('Authentication successful, user:', req.user);

    // Save authentication state to session
    if (req.session && req.user) {
      req.session.authState = {
        isAuthenticated: true,
        authToken: `oauth-token-${Date.now()}`,
        authTimestamp: Date.now(),
        userInfo: {
          id: (req.user as any).id,
          email: (req.user as any).email,
          name: (req.user as any).name || (req.user as any).displayName,
        },
      };

      console.log('Saving auth state to session:', req.session.authState);

      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('Session save error:', saveErr);
          return res.redirect('/?auth=error');
        }
        console.log('Session saved successfully, redirecting with auth=success');
        res.redirect('/?auth=success');
      });
    } else {
      console.error('No session or user found');
      res.redirect('/?auth=error');
    }
  });
});

export default controller;

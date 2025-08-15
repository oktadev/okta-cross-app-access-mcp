// This code is based on the node-oidc-provider example
// https://github.com/panva/node-oidc-provider/blob/73baae15001a30b8c29c3c35ea2b821a7fb3eafd/example/express.js

import { urlencoded } from 'express'; // eslint-disable-line import/no-unresolved
import { errors } from 'oidc-provider';
import passport from 'passport';
import { buildErrorMessage } from 'vite';
import makeConfiguration from '../server-configuration.js';
import { createOIDCStrategy, createPassportStrategy } from '../utils/passport-strategy.js';

const body = urlencoded({ extended: false });

const { SessionNotFound } = errors;

export default async (app, provider) => {
  const configuration = await makeConfiguration();

  // Build an OAuth error response and redirect back to the client
  function redirectWithError(req, res, error, error_description) {
    const result = { error, error_description };
    provider.interactionFinished(req, res, result, { mergeWithLastSubmission: false });
  }

  app.use((err, req, res, next) => {
    if (err instanceof SessionNotFound) {
      // handle interaction expired / session not found error
    }
    next(err);
  });

  app.use((req, res, next) => {
    const orig = res.render;
    // you'll probably want to use a full blown render engine capable of layouts
    res.render = (view, locals) => {
      app.render(view, locals, (err, html) => {
        if (err) throw err;
        orig.call(res, '_layout', {
          ...locals,
          body: html,
        });
      });
    };
    next();
  });

  function setNoCache(req, res, next) {
    res.set('cache-control', 'no-store');
    next();
  }

  // The user is redirected here after the OIDC server receives a request from a client.
  // Look up the configured SSO provider given the email domain from `login_hint` and redirect there.
  app.get('/interaction/:uid', setNoCache, async (req, res, next) => {
    try {
      const { uid, params } = await provider.interactionDetails(req, res);

      await provider.Client.find(params.client_id);

      console.log('Starting OAuth flow with ', params);

      if (!params.login_hint) {
        redirectWithError(req, res, 'invalid_request', 'Missing login_hint parameter.');
        return;
      }

      // Get email domain from login_hint
      const match = params.login_hint.match(/.+@(.+)/);
      if (!match) {
        redirectWithError(
          req,
          res,
          'invalid_request',
          'Invalid login_hint. Must be an email address.'
        );
        return;
      }
      const email_domain = match[1];

      // Find email domain in config
      const providerDetails = Object.values(configuration.providers).find((p) =>
        p.email_domains.includes(email_domain)
      );

      if (!providerDetails) {
        redirectWithError(req, res, 'invalid_request', 'No SSO provider for given login_hint');
        return;
      }

      // Start an OIDC flow to the provider for this email domain
      req.session.interaction_uid = uid;
      const strategy = createPassportStrategy(providerDetails);
      strategy._loginHint = params.login_hint;
      passport.authenticate(strategy)(req, res, next);
    } catch (err) {
      next(err);
    }
  });

  // Use this after successfully getting back info from the IdP to redirect back to the app
  app.get(
    '/openid/callback/:key',
    setNoCache,
    body,
    async (req, res, next) => {
      try {
        const sso_provider = configuration.providers[req.params.key];

        if (!sso_provider) {
          buildErrorMessage('invalid_request', 'Unknown provider in redirect');
          return;
        }

        const strategy = createOIDCStrategy(sso_provider);

        res.locals.uid = req.session.interaction_uid;

        // Finish passport authentication
        passport.authenticate(strategy, { keepSessionInfo: true })(req, res, next);
      } catch (err) {
        next(err);
      }
    },
    async (req, res, next) => {
      // Passport sets req.user as the return value of the verify function above
      try {
        const interactionDetails = await provider.interactionDetails(req, res);
        const {
          prompt: { details },
          params,
        } = interactionDetails;

        // If interactionDetails contains an existing grantId, update that
        let { grantId } = interactionDetails;
        let grant;
        if (grantId) {
          grant = await provider.Grant.find(grantId);
        } else {
          grant = new provider.Grant({
            accountId: req.user.id,
            clientId: params.client_id,
          });
          // Add the OIDC scopes to the grant. we'll probably want to make this dynamic based on whether the client requested "profile" and "email" though
          grant.addOIDCScope('openid profile email');
        }

        if (details.missingResourceScopes) {
          console.log('Adding Resource scopes', details.missingResourceScopes);
          for (const [indicator, scopes] of Object.entries(details.missingResourceScopes)) {
            grant.addResourceScope(indicator, scopes.join(' '));
          }
        }
        // TODO: If the client requests additional claims, missingOIDCClaims will be set, and we need to either add the scopes or return an error
        // if (details.missingOIDCClaims) {
        //     console.log("Adding OIDC claims");
        //     grant.addOIDCClaims(details.missingOIDCClaims);
        // }

        // TODO: We need to look for other missing data and error out if we can't provide it. Otherwise this gets stuck in an infinite loop.

        grantId = await grant.save();

        const result = {
          login: {
            accountId: req.user.id,
            // acr: '', TODO
            // amr: '', TODO
            remember: false,
          },
          consent: { grantId },
        };

        await provider.interactionFinished(req, res, result, { mergeWithLastSubmission: false });
      } catch (err) {
        next(err);
      }
    }
  );
};

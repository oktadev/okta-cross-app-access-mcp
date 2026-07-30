import { Router } from 'express';
import prisma from '../../prisma';

const controller: Router = Router();

controller.get('/', async (req, res) => {
  // Defense in depth: this controller returns access/refresh tokens, so never
  // run it without an authenticated user (guards against being mounted on an
  // unauthenticated route or the auth middleware being bypassed).
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  let subjectTokenType = 'urn:ietf:params:oauth:token-type:id_token';

  const tokens = await prisma.authorizationToken.findMany({
    where: {
      orgId: user.orgId,
      userId: user.id,
    },
  });

  // We get this info from redis purely for informational purposes to surface to the debug console
  const savedSubjectToken = await req.app.locals.redisClient.get(
    `jag_subject_token:${user.externalId}`
  );

  const savedSubjectTokenType = await req.app.locals.redisClient.get(
    `jag_subject_token_type:${user.externalId}`
  );
  if (savedSubjectTokenType === 'saml') {
    subjectTokenType = 'urn:ietf:params:oauth:token-type:saml2';
  }

  const requestBody = {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
    subject_token_type: subjectTokenType,
    audience: process.env.TODO_AUTH_SERVER,
    scope: 'read write',
    subject_token: savedSubjectToken ?? '',
    client_id: '<CLIENT_ID>',
    client_secret: '<CLIENT_SECRET>',
  };
  const url = `${process.env.AUTH_SERVER}/token`;
  const responseBody = {
    access_token: '', // frontend can tack on access token
    issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
    token_type: 'N_A',
    expires_in: 300,
  };

  res.send({ tokens, requestBody, responseBody, url });
});

export default controller;

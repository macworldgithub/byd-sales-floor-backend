const express = require('express');
const { authenticate } = require('../middleware/auth');
const { canManageUsers } = require('../services/accountAccess');
const { getUserManagement } = require('../services/userManagement');
const router = express.Router();
router.use(authenticate, (req, res, next) => {
  if (!canManageUsers(req.user)) return res.status(403).json({ success: false, message: 'User management requires the devs@omnisuiteai.com super admin account.' });
  next();
});
router.get('/', async (req, res, next) => {
  try { res.json({ success: true, data: await getUserManagement().list() }); } catch (error) { next(error); }
});
for (const method of ['post', 'patch', 'delete']) {
  router[method](method === 'post' ? '/' : '/:id', async (req, res, next) => {
    try {
      const data = await getUserManagement().mutate({ id: req.params.id, input: req.body, actor: req.user, ip: req.ip, remove: method === 'delete' });
      res.status(method === 'post' ? 201 : 200).json({ success: true, data });
    } catch (error) { next(error); }
  });
}
module.exports = router;

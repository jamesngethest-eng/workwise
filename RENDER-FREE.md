# Deploy Workwise on Render Free

The `render.yaml` blueprint is configured for a free Render web service. It will give the app a public `*.onrender.com` URL after you connect the project to a Git repository and deploy it.

## Free tier data limits

Render Free services use temporary local storage. This app currently stores accounts, jobs, applications, and uploaded CV files in local files, so that data can disappear when Render restarts or redeploys the service. Free services also spin down after a period without traffic, so the first visit after inactivity may take a little longer.

Use this setup as a public demo. For a live marketplace where user data must persist, the app needs a persistent database and file storage; Render's persistent disks require a paid service.

## Deploy

1. Put this project in a GitHub or GitLab repository. Do not commit `.workwise-data` or uploaded user files.
2. In Render, create a new **Blueprint** and connect that repository. Render will read `render.yaml`.
3. Set the prompted `WORKWISE_ADMIN_SETUP_KEY` environment variable to a long, private value, then deploy.
4. Open the public `onrender.com` address shown for the service.

Render needs access to a Git repository to deploy this blueprint. This local project folder is not currently connected to a Git repository.

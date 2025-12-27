# 🚀 Bloom Keeper Deployment Guide

This document contains the instructions for accessing and managing the Bloom Keeper bot on your DigitalOcean Droplet.

## 📡 Server Information
- **IP Address:** `146.190.7.44`
- **Username:** `root`
- **Project Path:** `/opt/bloom-keeper`

## 🔑 SSH Access
To log in to your server from your local machine, use the private key we generated:

```powershell
# Standard login command
ssh -i $HOME\.ssh\id_ed25519_keeper root@146.190.7.44
```

*Note: If you haven't added the key to your SSH agent, you must include the `-i` flag followed by the path to your key file.*

## 🛠️ Managing the Bot (PM2)
The bot is managed by **PM2**, which ensures it restarts automatically if it crashes or the server reboots.

- **View Logs (Real-time):** `pm2 logs bloom-keeper`
- **Check Status:** `pm2 status`
- **Restart Bot:** `pm2 restart bloom-keeper`
- **Stop Bot:** `pm2 stop bloom-keeper`
- **Interactive Dashboard:** `pm2 monit`

## 🤖 Automatic Deployments (GitHub Actions)
Deployments are handled automatically when you push code to the `main` branch via the `.github/workflows/deploy.yml` workflow.

### Required GitHub Secrets:
If you ever need to set up a new repository, ensure these **Actions Secrets** are added:
1. `DROPLET_IP`: `146.190.7.44`
2. `SSH_PRIVATE_KEY`: The contents of your local `id_ed25519_keeper` file.
3. `SSH_PASSPHRASE`: The password you set during `ssh-keygen`.

## 📂 Important File Locations
- **Environment Variables:** `/opt/bloom-keeper/server/.env`
- **Persistent Diagnostics (APY History):** `/opt/bloom-keeper/server/data/diagnostics-state.json`
- **Build Output:** `/opt/bloom-keeper/server/dist/`

## 🔄 Updating the Bot Manually
If you ever need to update the bot without using GitHub Actions:
```bash
cd /opt/bloom-keeper/server
git pull origin main
npm install
npm run build
pm2 restart bloom-keeper
```


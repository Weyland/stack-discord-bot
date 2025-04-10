# Use an official Node.js runtime as the base image
FROM node:22-alpine

# Install Docker CLI and other dependencies (curl, bash)
RUN apk add --no-cache \
    curl \
    bash \
    docker-cli

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if present) to the working directory
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application files to the working directory
COPY . .

# Expose the port your app will run on (not strictly necessary for the bot, but useful for future integration)
EXPOSE 8080

# Run the bot when the container starts
CMD ["npm", "start"]

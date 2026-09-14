const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { app } = require('./server'); // Wait, does index.js export app?

async function runTest() {
    // Need to find out if index.js exports app.
}
runTest();

// Mocks the DOM to be able to require CUI.
const jsdom = require('jsdom');
global.window = new jsdom.JSDOM(`<!DOCTYPE html>`, { url: "https://example.com/" }).window;
global.window.Error = () => {
};
global.alert = () => {
};
global.navigator = window.navigator;
global.document = window.document;
global.HTMLElement = window.HTMLElement;
global.HTMLCollection = window.HTMLCollection;
global.NodeList = window.NodeList;
global.Node = window.Node;
global.self = global;

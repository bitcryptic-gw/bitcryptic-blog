---
title: "Fixture Home"
slug: ""
description: "The fixture home page."
order: 0
layout: home
status: published

hero:
  headline: "Agents read the web."
  highlight: "markdown."
  lead: "A fixture page with every section the home layout knows."
  actions:
    - label: "See the difference"
      href: "#race"
      style: primary
    - label: "Read the page"
      href: "/about/"
      style: secondary

unchanged:
  heading: "Nothing changes for your visitors."
  lead: "Browsers get the designed page; agents that ask get markdown."
  address: "example.com/recipes"
  panels:
    - title: "A person in a browser"
      body: "gets the designed page."
      art: browser
    - title: "one address"
      body: "The request says which version it wants."
      art: address
    - title: "An agent that asks"
      body: "gets the same words as markdown."
      art: agent
  notes:
    - title: "Your pages stay put"
      body: "Same URLs."
    - title: "Free stays free"
      body: "Most sites charge nothing."
    - title: "Easy to undo"
      body: "Switch it off again."

compare:
  heading: "Same question. Two different trips."
  lead: "One page, two representations."
  credit: "Token counts: Cloudflare's measurement."
  items:
    - label: "Without MDF"
      body: "The whole page."
      art: messy
      tokens: "16,180"
      tone: orange
    - label: "With MDF"
      body: "Just the words."
      art: tidy
      tokens: "3,150"
      tone: blue

steps:
  heading: "How it works"
  items:
    - title: "Ask for markdown"
      body: "Send `Accept: text/markdown`."
    - title: "Read the menu"
      body: "Read `/mdf.json`."

paths:
  heading: "Where do you come in?"
  items:
    - title: "I run a website"
      body: "Install the plugin."
      linkLabel: "Get the plugin"
      href: "/about/"
      tone: blue
    - title: "I build agents"
      body: "Send one header."
      linkLabel: "Point an agent at the demo"
      href: "https://mdf-demo.example"
      tone: plain

running:
  heading: "Running today"
  items:
    - title: "demo.example"
      body: "The live demo."
      href: "https://mdf-demo.example"
    - title: "[First adopter: example.org]"
      body: "[Placeholder]"
      placeholder: true

faq:
  heading: "Fair questions"
  items:
    - q: "Will my visitors notice anything?"
      a: "No."
    - q: "Do I have to charge?"
      a: "No."
---

This is the markdown body of the fixture home page, which is what an agent receives when
it sends `Accept: text/markdown` to `/`. It has to say everything the designed page says,
in plain text, which is why the validator will not accept a custom-layout page whose body
is a placeholder or a single line.

Nothing changes for your visitors: browsers get the designed page, and only a request that
asks for markdown gets markdown. That request is one header, `Accept: text/markdown`, at the
same URL a browser would load.

An agent reads `/mdf.json` to see what the site offers and what each section costs, and pays
with a Lightning invoice or USDC on Base when a page is priced. A free-only site is a
perfectly good MDF site, and most sites charge nothing.

Token counts: Cloudflare measured its own page as HTML and as markdown (Markdown for
Agents, February 2026): 16,180 tokens and 3,150 tokens.

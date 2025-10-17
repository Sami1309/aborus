"""Browser-use executor for LLM-powered automation steps."""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Dict, Optional

try:
    from browser_use import Agent, Browser, Controller
    from langchain_anthropic import ChatAnthropic
    BROWSER_USE_AVAILABLE = True
except ImportError:
    BROWSER_USE_AVAILABLE = False
    Agent = None  # type: ignore
    Browser = None  # type: ignore
    Controller = None  # type: ignore
    ChatAnthropic = None  # type: ignore


logger = logging.getLogger(__name__)


class BrowserUseExecutor:
    """Executes automation steps using browser-use LLM agent."""

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        headless: bool = False,
    ) -> None:
        if not BROWSER_USE_AVAILABLE:
            raise RuntimeError(
                "browser-use is not installed. Install with: uv pip install browser-use"
            )

        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        self.model = model or os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4")
        self.headless = headless

        if not self.api_key:
            raise ValueError(
                "ANTHROPIC_API_KEY is required. Set it in .env or pass as api_key parameter."
            )

    async def execute_step(
        self,
        step: Dict[str, Any],
        context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Execute a single LLM automation step using browser-use.

        Args:
            step: The automation step with title, description, hints, etc.
            context: Optional context including current URL, session data, etc.

        Returns:
            Dict with outcome, message, and any extracted data
        """
        title = step.get("title", "Automation step")
        description = step.get("description", title)
        hints = step.get("hints") or {}

        # Build task prompt for the agent
        task_parts = [description]

        # Add hints as additional context
        if hints.get("user_value"):
            task_parts.append(f"Value to use: {hints['user_value']}")
        if hints.get("text"):
            task_parts.append(f"Text context: {hints['text']}")
        if hints.get("expected_outcome"):
            task_parts.append(f"Expected outcome: {hints['expected_outcome']}")

        task = " ".join(task_parts)

        logger.info(f"Executing LLM step: {title}")
        logger.debug(f"Task prompt: {task}")

        try:
            # Initialize the LLM
            llm = ChatAnthropic(
                model=self.model,
                api_key=self.api_key,
                timeout=120,
                max_retries=2,
            )

            # Create browser and agent
            browser = Browser(
                config={
                    "headless": self.headless,
                    "disable_security": False,
                }
            )

            controller = Controller()
            agent = Agent(
                task=task,
                llm=llm,
                browser=browser,
                controller=controller,
            )

            # Run the agent
            result = await agent.run()

            logger.info(f"LLM step completed: {title}")

            return {
                "outcome": "succeeded",
                "message": f"Successfully executed: {title}",
                "result": result,
                "execution_mode": "llm",
            }

        except Exception as error:
            logger.exception(f"LLM step failed: {title}")
            return {
                "outcome": "failed",
                "message": f"LLM execution failed: {str(error)}",
                "error": str(error),
                "execution_mode": "llm",
            }

    async def execute_steps(
        self,
        steps: list[Dict[str, Any]],
        context: Optional[Dict[str, Any]] = None,
    ) -> list[Dict[str, Any]]:
        """
        Execute multiple LLM automation steps sequentially.

        Args:
            steps: List of automation steps
            context: Optional shared context

        Returns:
            List of results for each step
        """
        results = []
        for step in steps:
            result = await self.execute_step(step, context)
            results.append(result)

            # Stop on first failure
            if result.get("outcome") == "failed":
                break

        return results


async def execute_llm_step(
    step: Dict[str, Any],
    *,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
    headless: bool = False,
) -> Dict[str, Any]:
    """
    Convenience function to execute a single LLM step.

    Args:
        step: The automation step to execute
        api_key: Optional Anthropic API key (defaults to ANTHROPIC_API_KEY env var)
        model: Optional model name (defaults to ANTHROPIC_MODEL env var or claude-sonnet-4)
        headless: Whether to run browser in headless mode

    Returns:
        Dict with outcome, message, and result
    """
    executor = BrowserUseExecutor(
        api_key=api_key,
        model=model,
        headless=headless,
    )
    return await executor.execute_step(step)

from getpass import getpass

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from accounts.models import AuthSession
from accounts.service import AccountError, register


class Command(BaseCommand):
    help = "Create a pilot account interactively without granting consent or retaining an API token."

    def add_arguments(self, parser):
        parser.add_argument("email")

    def handle(self, *args, **options):
        password = getpass("Pilot password: ")
        if password != getpass("Confirm pilot password: "):
            raise CommandError("Passwords differ.")
        try:
            with transaction.atomic():
                account = register({"email": options["email"], "password": password}, "operator")
                AuthSession.objects.filter(user__account_profile__public_id=account["account"]["accountId"]).delete()
        except AccountError as error:
            raise CommandError(error.code) from None
        self.stdout.write("Pilot account created. Sign in from Liftlog.")
